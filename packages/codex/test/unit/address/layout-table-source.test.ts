/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Diff the committed layout table against the dataset it was generated from, country by country.
 *
 *   The generated half of the table is 186 transcriptions of a libaddressinput `fmt` string. A transcription error does
 *   not look like one: it reads as a plausible address from somewhere else, and no reviewer of a 1215-line generated
 *   file catches it. So the comparison is mechanical — re-derive each skeleton from the dataset and require the
 *   committed layout to print the same fields in the same order with the same line breaks.
 *
 *   It reads the dataset through `@mailwoman/core`, which is legal for a test and not for `lib/`: `@mailwoman/core`
 *   imports `@mailwoman/codex`. Therefore, a source file here reaching back would close that loop. This file lives under
 *   `test/`, which nothing imports, and codex's own manifest stays free of core. The former home was
 *   `@mailwoman/core`, and `@mailwoman/core` imports `@mailwoman/codex`. A codex test reading the dataset would close
 *   that loop. this package already depends on both.
 *
 *   The eleven hand-authored countries are not compared here. Those depart from the dataset on purpose, and
 *   `@mailwoman/codex`'s own test pins each departure against its reason.
 */

import { isAlternation, isLayout, isSlot, type AddressAtom, type AddressLayout } from "@mailwoman/codex/address-layout"
import { ADDRESS_LAYOUTS, layoutForCountry } from "@mailwoman/codex/address-layouts"
import { GENERATED_ADDRESS_LAYOUTS } from "@mailwoman/codex/address-layouts-generated"
import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { stringifyJSON } from "@mailwoman/core/json"
import { resolvePackagePath } from "@mailwoman/core/module/resolvers"
import { join } from "path-ts"
import { Globerator } from "spliterator/node/fs"
import { describe, expect, it } from "vitest"

/**
 * Libaddressinput's placeholder vocabulary in this project's tag names.
 *
 * `%A` is the one opaque street-address field the table expands into several tags,
 * so it compares as a single marker.
 */
const FIELD: Readonly<Record<string, string>> = {
	N: "attention",
	O: "venue",
	A: "«street»",
	D: "dependent_locality",
	C: "locality",
	S: "region",
	Z: "postcode",
	X: "cedex",
	R: "country",
}

/**
 * The skeleton a layout prints: field names per line, street line collapsed to one marker.
 *
 * Two slots drop out.
 * Both are authored rather than transcribed, so comparing them against the source would
 * report every country carrying one as a departure and say nothing:
 *
 * - `country`, because `%R` is absent from nearly every `fmt` — libaddressinput's
 *   consumers add the destination country themselves.
 * - `dependent_locality`, for the 47 countries measured as printing one; `%D` appears in 14
 *   of the 197 shipped `fmt` strings, and a country that really has the line still needs it.
 *   It takes a line of its own beside the locality, or a place inside the locality's line
 *   where that line also carries the street, so it is dropped wherever it sits rather than
 *   only as a line. where the generator put it is what `address-layouts.test.ts` checks.
 */
const AUTHORED_SLOTS = new Set(["country", "dependent_locality"])

function skeletonOfLayout(layout: AddressLayout, source: readonly string[][]): string[][] {
	// A slot counts as authored only when the source does not name it.
	// The 14 `fmt` strings that carry `%D` are compared like any other line,
	// so a transcription error there still fails.
	const inSource = new Set(source.flat())
	const transcribed = (name: string): boolean => !AUTHORED_SLOTS.has(name) || inSource.has(name)

	return layout.lines.map((line) => line.flatMap(nameOf).filter(transcribed)).filter((line) => line.length)
}

function nameOf(atom: AddressAtom): string[] {
	if (isSlot(atom)) return [atom.tag]

	// An alternation or a nested layout is the street line however that country spells it.
	if (isAlternation(atom) || isLayout(atom)) return ["«street»"]

	return []
}

/**
 * The skeleton a `fmt` prints, in the same vocabulary.
 *
 * A placeholder this project does not model drops out, which is what lets a country whose
 * `fmt` names only such fields be reported as unusable rather than as a mismatch.
 */
function skeletonOfFormat(fmt: string): string[][] {
	return fmt
		.split("%n")
		.map((line) => [...line.matchAll(/%([A-Z])/g)].flatMap(([, code]) => (FIELD[code!] ? [FIELD[code!]!] : [])))
		.filter((line) => line.length)
}

const specsDirectory = resolvePackagePath("@mailwoman/core", "data", "chromium-i18n", "ssl-address")

const countryFormats = await (async () => {
	const out = new Map<string, string | null>()

	for (const file of await Globerator.files("json", {
		cwd: specsDirectory,
		absolute: false,
		recursive: false,
	}).toSorted()) {
		const metadata = await readLocalJSONFile<{ fmt?: string }>(join(specsDirectory, file))

		out.set(file.replace(/\.json$/, ""), metadata.fmt ?? null)
	}

	return out
})()

describe("the generated layout table matches libaddressinput", () => {
	it("reads the dataset it claims to be generated from", () => {
		// A directory read that answered nothing would make every assertion below pass vacuously.
		expect(countryFormats.size).toBeGreaterThan(240)
		expect(countryFormats.get("US")).toBe("%N%n%O%n%A%n%C, %S %Z")
	})

	it("prints the same skeleton as its source `fmt`, for every generated country", () => {
		const mismatches: string[] = []

		for (const [country, layout] of Object.entries(GENERATED_ADDRESS_LAYOUTS)) {
			const fmt = countryFormats.get(country)

			if (!fmt) {
				mismatches.push(`${country}: generated a layout from a dataset record that carries no fmt`)

				continue
			}

			const source = skeletonOfFormat(fmt)
			const expected = stringifyJSON(source)
			const actual = stringifyJSON(skeletonOfLayout(layout, source))

			if (expected !== actual) {
				mismatches.push(`${country}: fmt ${stringifyJSON(fmt)} reads ${expected}, layout prints ${actual}`)
			}
		}

		expect(mismatches).toEqual([])
	})

	it("names a layout for every country whose `fmt` this project can model", () => {
		const missing: string[] = []

		for (const [country, fmt] of countryFormats) {
			if (!fmt || !skeletonOfFormat(fmt).length) continue

			if (!layoutForCountry(country)) {
				missing.push(`${country}: fmt ${stringifyJSON(fmt)}`)
			}
		}

		expect(missing).toEqual([])
	})

	it("leaves the hand-authored countries to their own table", () => {
		for (const country of Object.keys(ADDRESS_LAYOUTS)) {
			expect(GENERATED_ADDRESS_LAYOUTS[country], `${country} is generated as well as hand-authored`).toBeUndefined()
		}
	})

	it("answers null for a country the dataset gives no usable order", () => {
		const unusable = [...countryFormats].filter(([, fmt]) => !fmt || !skeletonOfFormat(fmt).length).map(([cc]) => cc)

		// Absence is a real answer here: rendering nothing beats inventing an order.
		// The count is pinned so that a dataset refresh which quietly drops a country's
		// `fmt` shows up as a failure rather than as silence.
		expect(unusable).toHaveLength(55)

		for (const country of unusable) {
			expect(layoutForCountry(country), `${country} has no layout`).toBeNull()
		}
	})
})
