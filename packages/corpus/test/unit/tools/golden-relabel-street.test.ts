/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Fixture rows for the golden street-suffix relabel (v0.1.2 → v0.1.3). Every class the tool
 *   distinguishes gets a row here, including the ones it must LEAVE ALONE — those are the
 *   interesting half, because a relabel that over-reaches silently rewrites the answer key.
 */

import { type GoldenStreetRow, relabelGoldenStreetRow } from "@mailwoman/corpus/tools/golden-relabel-street"
import { describe, expect, it } from "vitest"

const row = (components: Record<string, string>, extra: Partial<GoldenStreetRow> = {}): GoldenStreetRow => ({
	raw: "(unused by the row-level relabel)",
	components,
	country: "US",
	...extra,
})

describe("relabelGoldenStreetRow", () => {
	it("splits a plain trailing suffix", () => {
		const out = relabelGoldenStreetRow(row({ house_number: "123", street: "Main St", locality: "Springfield" }))

		expect(out.changed).toBe(true)
		expect(out.rowClass).toBe("split-suffix")
		expect(out.row.components.street).toBe("Main")
		expect(out.row.components.street_suffix).toBe("St")
	})

	it("inserts street_suffix directly after street, preserving key order", () => {
		const out = relabelGoldenStreetRow(row({ house_number: "123", street: "Main St", locality: "Springfield" }))

		expect(Object.keys(out.row.components)).toEqual(["house_number", "street", "street_suffix", "locality"])
	})

	it("passes an already-split row through untouched", () => {
		const input = row({ street_prefix: "SE", street: "Salmon", street_suffix: "St" })
		const out = relabelGoldenStreetRow(input)

		expect(out.changed).toBe(false)
		expect(out.rowClass).toBe("already-split")
		expect(out.row).toBe(input)
	})

	it("leaves a single-token street folded", () => {
		const out = relabelGoldenStreetRow(row({ street: "Broadway" }))

		expect(out.changed).toBe(false)
		expect(out.rowClass).toBe("single-token")
	})

	it("leaves a street that is ENTIRELY one suffix word folded, and says so", () => {
		const out = relabelGoldenStreetRow(row({ street: "Circle" }))

		expect(out.changed).toBe(false)
		expect(out.rowClass).toBe("suffix-only-street")
	})

	it("keeps a street-type + post-directional tail together (the TIGER decomposition)", () => {
		const out = relabelGoldenStreetRow(row({ street: "Pennsylvania Avenue NW" }))

		expect(out.changed).toBe(true)
		expect(out.rowClass).toBe("split-suffix-postdirectional")
		expect(out.row.components.street).toBe("Pennsylvania")
		expect(out.row.components.street_suffix).toBe("Avenue NW")
	})

	it("handles the abbreviated post-directional tail", () => {
		const out = relabelGoldenStreetRow(row({ street: "Woodland Ave NE" }))

		expect(out.row.components.street).toBe("Woodland")
		expect(out.row.components.street_suffix).toBe("Ave NE")
	})

	it("leaves a BARE post-directional tail folded (no Pub-28 suffix present)", () => {
		const out = relabelGoldenStreetRow(row({ street: "Seymour East" }))

		expect(out.changed).toBe(false)
		expect(out.rowClass).toBe("postdirectional-tail-only")
	})

	it("refuses to strip a post-directional when it would leave the street empty", () => {
		// "1ST AVE SW BOX E": trailing "E" is a directional but "BOX" is no suffix — the b1 branch
		// must not fire, and the b3 branch is not applied at all.
		const out = relabelGoldenStreetRow(row({ street: "1ST AVE SW BOX E" }))

		expect(out.changed).toBe(false)
		expect(out.rowClass).toBe("postdirectional-tail-only")
	})

	it("leaves a multi-token street with no recognized suffix folded", () => {
		const out = relabelGoldenStreetRow(row({ street: "Fire Ln 1 Grovers" }))

		expect(out.changed).toBe(false)
		expect(out.rowClass).toBe("no-suffix-match")
	})

	it("never touches a non-US row", () => {
		const input = row({ street: "Rue de la Paix" }, { country: "FR" })
		const out = relabelGoldenStreetRow(input)

		expect(out.changed).toBe(false)
		expect(out.rowClass).toBe("not-us")
		expect(out.row).toBe(input)
	})

	it("keeps the surface bytes exact — head + gap + tail reconstructs the original", () => {
		const original = "Old  Mill   Road"
		const out = relabelGoldenStreetRow(row({ street: original }))

		expect(out.row.components.street).toBe("Old  Mill")
		expect(out.row.components.street_suffix).toBe("Road")
		expect(`${out.row.components.street}   ${out.row.components.street_suffix}`).toBe(original)
	})

	it("preserves the row's own casing on both sides of the split", () => {
		const out = relabelGoldenStreetRow(row({ street: "DELONG LN" }))

		expect(out.row.components.street).toBe("DELONG")
		expect(out.row.components.street_suffix).toBe("LN")
	})

	it("flags a split whose remainder is itself an affix token", () => {
		const out = relabelGoldenStreetRow(row({ street: "East Rd" }))

		expect(out.changed).toBe(true)
		expect(out.flags.map((f) => f.kind)).toContain("remainder-is-affix")
	})

	it("flags a name-prone suffix word", () => {
		const out = relabelGoldenStreetRow(row({ street: "Mt Tabor Park" }))

		expect(out.changed).toBe(true)
		expect(out.flags.map((f) => f.kind)).toContain("name-prone-suffix")
	})

	it("flags a split whose suffix word also occurs in the row's venue", () => {
		const out = relabelGoldenStreetRow(row({ venue: "Lincoln Park Zoo", street: "Lincoln Park" }))

		expect(out.changed).toBe(true)
		expect(out.flags.map((f) => f.kind)).toContain("venue-context")
	})

	it("does not flag the ordinary case — a venue alone is not a trigger", () => {
		const plain = relabelGoldenStreetRow(row({ house_number: "6220", street: "Salmon St" }))

		expect(plain.flags).toEqual([])

		const withVenue = relabelGoldenStreetRow(row({ venue: "Seattle Art Museum", street: "1st Ave" }))

		expect(withVenue.changed).toBe(true)
		expect(withVenue.flags).toEqual([])
	})

	it("lifts a leading directional into street_prefix", () => {
		const out = relabelGoldenStreetRow(row({ street: "N Desmet Avenue" }))

		expect(out.prefixSplit).toBe(true)
		expect(out.row.components.street_prefix).toBe("N")
		expect(out.row.components.street).toBe("Desmet")
		expect(out.row.components.street_suffix).toBe("Avenue")
		expect(Object.keys(out.row.components)).toEqual(["street_prefix", "street", "street_suffix"])
	})

	it("lifts a leading directional with no suffix present", () => {
		const out = relabelGoldenStreetRow(row({ street: "South Cesar Chavez" }))

		expect(out.rowClass).toBe("split-prefix-only")
		expect(out.row.components.street_prefix).toBe("South")
		expect(out.row.components.street).toBe("Cesar Chavez")
		expect(out.row.components.street_suffix).toBeUndefined()
	})

	it("does not lift a directional that would leave the street empty", () => {
		// "S St" → suffix "St" leaves "S"; lifting it would leave no name at all.
		const out = relabelGoldenStreetRow(row({ street: "S St" }))

		expect(out.prefixSplit).toBe(false)
		expect(out.row.components.street).toBe("S")
		expect(out.row.components.street_suffix).toBe("St")
	})

	it("leaves an existing street_prefix alone", () => {
		const out = relabelGoldenStreetRow(row({ street_prefix: "SE", street: "Hawthorne Blvd" }))

		expect(out.prefixSplit).toBe(false)
		expect(out.row.components.street_prefix).toBe("SE")
		expect(out.row.components.street).toBe("Hawthorne")
		expect(out.row.components.street_suffix).toBe("Blvd")
	})

	it("honors splitPrefix: false", () => {
		const out = relabelGoldenStreetRow(row({ street: "N Desmet Avenue" }), { splitPrefix: false })

		expect(out.prefixSplit).toBe(false)
		expect(out.row.components.street_prefix).toBeUndefined()
		expect(out.row.components.street).toBe("N Desmet")
	})

	it("reports a row with no street at all", () => {
		const out = relabelGoldenStreetRow(row({ po_box: "PO Box 123", locality: "Burlington" }))

		expect(out.changed).toBe(false)
		expect(out.rowClass).toBe("no-street")
	})
})
