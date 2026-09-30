/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Diff the committed layout table against the dataset it was generated from, country by country.
 *
 *   The generated half of the table contains 186 transcriptions of libaddressinput `fmt` strings. A transcription error
 *   can produce a plausible address from another place. Reviewers can miss it in the 1,215-line generated file.
 *   This test re-derives each skeleton from the dataset. It requires the committed layout to print the same fields,
 *   in the same order, with the same line breaks.
 *
 *   The test reads the dataset through `@mailwoman/core`. Production files under `lib/` cannot import core because
 *   core imports `@mailwoman/codex`. This test lives under `test/`, which application code does not import.
 *   The codex manifest therefore stays free of core.
 *
 *   The test skips eleven hand-authored countries because their layouts intentionally differ from the dataset.
 *   A separate `@mailwoman/codex` test records the reason for each difference.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { stringifyJSON } from "@mailwoman/core/json"
import { resolvePackageDirectory } from "@mailwoman/core/module/resolvers"
import { Globerator } from "spliterator/node/fs"
import { describe, expect, it } from "vitest"

import { isAlternation, isLayout, isSlot, type AddressAtom, type AddressLayout } from "#address/layout"
import { ADDRESS_LAYOUTS, layoutForCountry } from "#address/layouts"
import { GENERATED_ADDRESS_LAYOUTS } from "#address/layouts/generated"
import { S42_ADDRESS_LAYOUTS } from "#address/layouts/s42"

/**
 * Libaddressinput's placeholder vocabulary in this project's tag names; `%A` is the one opaque
 * street-address field the table expands into several tags, so it compares as a single marker.
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
 * Two slots are authored rather than transcribed, so the skeleton comparison omits them.
 *
 * Either slot would mark every country that uses it as a departure without testing transcription:
 *
 * - `country`, because `%R` is absent from nearly every `fmt` — libaddressinput's
 *   consumers add the destination country themselves.
 * - `dependent_locality`, for the 47 countries measured as printing one.
 *   `%D` appears in 14 of the 197 shipped `fmt` strings.
 *   A country that has the line still needs it.
 *   It takes a line of its own beside the locality, or a place inside the locality's line where
 *   that line also contains the street, so it is dropped wherever it sits rather than only as a line.
 *   Where the generator put it is what `address-layouts.test.ts` checks.
 */
const AUTHORED_SLOTS = new Set(["country", "dependent_locality"])

function skeletonOfLayout(layout: AddressLayout, source: readonly string[][]): string[][] {
	// A slot counts as authored only when the source does not define it.
	// The 14 `fmt` strings that include `%D` are compared like any other line,
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
 * A placeholder this project does not model drops out.
 *
 * A country whose `fmt` contains only such fields is reported as unusable rather than as a mismatch.
 */
function skeletonOfFormat(fmt: string): string[][] {
	return fmt
		.split("%n")
		.map((line) => [...line.matchAll(/%([A-Z])/g)].flatMap(([, code]) => (FIELD[code!] ? [FIELD[code!]!] : [])))
		.filter((line) => line.length)
}

const specsDirectory = resolvePackageDirectory("@mailwoman/core")("data", "chromium-i18n", "ssl-address")

const countryFormats = await (async () => {
	const out = new Map<string, string | null>()

	for (const file of await Globerator.files("json", {
		cwd: specsDirectory,
		absolute: false,
		recursive: false,
	}).toSorted()) {
		const metadata = await readLocalJSONFile<{ fmt?: string }>(specsDirectory(file))

		out.set(file.replace(/\.json$/, ""), metadata.fmt ?? null)
	}

	return out
})()

describe("the generated layout table matches libaddressinput", () => {
	it("reads the dataset it claims to be generated from", () => {
		// A directory read that returned no records would make every assertion below pass vacuously.
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

	it("answers null for a country no source states an order for", () => {
		const unusable = [...countryFormats].filter(([, fmt]) => !fmt || !skeletonOfFormat(fmt).length).map(([cc]) => cc)

		// Absence is a real answer here: rendering no text beats inventing an order.
		// The count is pinned so that a dataset refresh which quietly drops a country's
		// `fmt` shows up as a failure rather than as silence.
		expect(unusable).toHaveLength(55)

		// A country the dataset leaves unusable may still have an approved S42 template.
		// Its Standardized Address Format Description states an order this repository read.
		// That is a second source rather than a second reading of the same one.
		for (const country of unusable) {
			const layout = layoutForCountry(country)

			if (S42_ADDRESS_LAYOUTS[country]) {
				expect(layout, `${country} reads its order from a SAFD`).toBe(S42_ADDRESS_LAYOUTS[country])

				continue
			}

			expect(layout, `${country} has no layout`).toBeNull()
		}
	})
})
