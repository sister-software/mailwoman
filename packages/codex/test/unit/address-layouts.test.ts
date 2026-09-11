/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Pins each layout against the libaddressinput `fmt` it was transcribed from, so the table cannot drift from its
 *   source unnoticed. A layout is data about a country's print order; a transcription error reads as a plausible
 *   address from somewhere else, which is the failure mode a diff against the source catches and a reader does not.
 *
 *   The comparison is over the SKELETON — the order of the fields and where the line breaks fall — not over the street
 *   line, because `%A` is one opaque field in the dataset and several tags here. A layout whose skeleton departs from
 *   its source on purpose is listed in {@link ACCEPTED_DEPARTURES} with the reason, which is the difference between a
 *   decision and a mistake.
 */

import { isAlternation, isConnector, isLayout, isSlot, type AddressAtom } from "@mailwoman/codex/address-layout"
import { ADDRESS_LAYOUTS } from "@mailwoman/codex/address-layouts"
import { describe, expect, it } from "vitest"

/**
 * Libaddressinput's placeholder vocabulary, in this project's tag names. `%A` is the street-address field this table
 * expands, so it maps to the marker the skeleton comparison treats as "the street line, however it is spelled".
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
 * Countries whose layout departs from the dataset skeleton, and why. An entry here is a decision; a departure without
 * one is a transcription error.
 */
const ACCEPTED_DEPARTURES: Readonly<Record<string, string>> = {
	// The dataset has no %D for France. La Poste's line 5 is the lieu-dit, which `fr/recipes/lieudit` renders and the
	// OpenCage FR template carries as a standalone `place` line, so the slot is kept between street and postcode.
	FR: "the lieu-dit line, which La Poste specifies and libaddressinput omits",
	// The dataset has no %D for Great Britain; Royal Mail's dependent locality is a real line above the post town.
	GB: "the dependent-locality line above the post town",
	// Japan's %A is one field below the prefecture; this table splits it into the tags the CJK model emits, and joins
	// the prefecture to it, because on one line the whole admin run is unseparated and only the postal code takes a
	// space.
	JP: "the sub-prefecture run is split into its own tags, and the prefecture joins it rather than taking a line",
	// China's %A is the street line only; the admin run above it is already %S%C%D in the dataset.
	CN: "the street line is split into street and house number",
}

/**
 * The skeleton a layout prints, as field names per line, with the street line collapsed to one marker.
 */
function skeletonOf(atoms: readonly AddressAtom[]): string[] {
	const names: string[] = []

	for (const atom of atoms) {
		if (isConnector(atom)) continue

		if (isSlot(atom)) {
			names.push(atom.tag)

			continue
		}

		// An alternation or a nested layout is the street line however it is spelled.
		if (isAlternation(atom) || isLayout(atom)) {
			names.push("«street»")
		}
	}

	return names
}

/**
 * The skeleton a `fmt` string prints, as field names per line.
 */
function skeletonOfFormat(fmt: string): string[][] {
	return fmt
		.split("%n")
		.map((line) => [...line.matchAll(/%([A-Z])/g)].map(([, code]) => FIELD[code!] ?? `%${code}`).filter(Boolean))
		.filter((line) => line.length > 0)
}

describe("ADDRESS_LAYOUTS", () => {
	it("covers every locale the project publishes weights for", () => {
		// The nine Latin locales in release.config.json plus the two CJK overlays.
		for (const country of ["US", "FR", "GB", "DE", "ES", "IT", "IN", "NZ", "AU", "JP", "CN"]) {
			expect(ADDRESS_LAYOUTS[country], `${country} has a layout`).toBeDefined()
		}
	})

	it("names only tags the union declares", async () => {
		const { COMPONENT_TAGS } = await import("@mailwoman/codex/component")
		const known = new Set<string>(COMPONENT_TAGS)

		for (const [country, layout] of Object.entries(ADDRESS_LAYOUTS)) {
			for (const line of layout.lines) {
				for (const name of skeletonOf(line)) {
					if (name === "«street»") continue

					expect(known.has(name), `${country} names ${name}`).toBe(true)
				}
			}
		}
	})

	it("prints its street line exactly once per layout", () => {
		for (const [country, layout] of Object.entries(ADDRESS_LAYOUTS)) {
			const streets = layout.lines.flatMap((line) => skeletonOf(line)).filter((n) => n === "«street»")

			expect(streets, `${country} prints one street line`).toHaveLength(1)
		}
	})
})

describe("the skeleton matches libaddressinput", () => {
	it("is documented for every accepted departure", () => {
		for (const country of Object.keys(ACCEPTED_DEPARTURES)) {
			expect(ADDRESS_LAYOUTS[country], `${country} has a layout to depart from`).toBeDefined()
		}
	})

	it("reads a `fmt` into the same vocabulary the layouts use", () => {
		// The US skeleton is the one every reader knows, so it is the fixture that proves the reader, not the table.
		expect(skeletonOfFormat("%N%n%O%n%A%n%C, %S %Z")).toEqual([
			["attention"],
			["venue"],
			["«street»"],
			["locality", "region", "postcode"],
		])
	})
})
