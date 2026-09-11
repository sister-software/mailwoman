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
 *   It lives in `@mailwoman/formatter` rather than in `@mailwoman/codex` because the dataset ships inside
 *   `@mailwoman/core`, and `@mailwoman/core` imports `@mailwoman/codex`. A codex test reading the dataset would close
 *   that loop; this package already depends on both.
 *
 *   The eleven hand-authored countries are NOT compared here. Those depart from the dataset on purpose, and
 *   `@mailwoman/codex`'s own test pins each departure against its reason.
 */

import { isAlternation, isLayout, isSlot, type AddressAtom, type AddressLayout } from "@mailwoman/codex/address-layout"
import { ADDRESS_LAYOUTS, layoutForCountry } from "@mailwoman/codex/address-layouts"
import { GENERATED_ADDRESS_LAYOUTS } from "@mailwoman/codex/address-layouts-generated"
import { readDirectory, readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { resolvePackagePath } from "@mailwoman/core/module/resolvers"
import { join } from "path-ts"
import { describe, expect, it } from "vitest"

/**
 * Libaddressinput's placeholder vocabulary in this project's tag names. `%A` is the one opaque street-address field the
 * table expands into several tags, so it compares as a single marker.
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
 */
function skeletonOfLayout(layout: AddressLayout): string[][] {
	return layout.lines.map((line) => line.flatMap(nameOf))
}

function nameOf(atom: AddressAtom): string[] {
	if (isSlot(atom)) return [atom.tag]

	// An alternation or a nested layout is the street line however that country spells it.
	if (isAlternation(atom) || isLayout(atom)) return ["«street»"]

	return []
}

/**
 * The skeleton a `fmt` prints, in the same vocabulary. A placeholder this project does not model drops out, which is
 * what lets a country whose `fmt` names only such fields be reported as unusable rather than as a mismatch.
 */
function skeletonOfFormat(fmt: string): string[][] {
	return fmt
		.split("%n")
		.map((line) => [...line.matchAll(/%([A-Z])/g)].flatMap(([, code]) => (FIELD[code!] ? [FIELD[code!]!] : [])))
		.filter((line) => line.length > 0)
}

const specsDirectory = resolvePackagePath("@mailwoman/core", "data", "chromium-i18n", "ssl-address")

const countryFormats = await (async () => {
	const out = new Map<string, string | null>()

	for (const file of (await readDirectory(specsDirectory)).toSorted()) {
		if (!file.endsWith(".json")) continue

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

			const expected = JSON.stringify(skeletonOfFormat(fmt))
			const actual = JSON.stringify(skeletonOfLayout(layout))

			if (expected !== actual) {
				mismatches.push(`${country}: fmt ${JSON.stringify(fmt)} reads ${expected}, layout prints ${actual}`)
			}
		}

		expect(mismatches).toEqual([])
	})

	it("names a layout for every country whose `fmt` this project can model", () => {
		const missing: string[] = []

		for (const [country, fmt] of countryFormats) {
			if (!fmt || !skeletonOfFormat(fmt).length) continue

			if (!layoutForCountry(country)) {
				missing.push(`${country}: fmt ${JSON.stringify(fmt)}`)
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

		// Absence is a real answer here: rendering nothing beats inventing an order. The count is pinned so that a
		// dataset refresh which quietly drops a country's `fmt` shows up as a failure rather than as silence.
		expect(unusable).toHaveLength(55)

		for (const country of unusable) {
			expect(layoutForCountry(country), `${country} has no layout`).toBeNull()
		}
	})
})
