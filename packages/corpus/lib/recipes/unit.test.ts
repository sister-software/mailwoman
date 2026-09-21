/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file `unit` — the surfaces the recipe must attest, and the layout shares it must preserve.
 *
 *   The recipe reads real OpenAddresses zips, so the recipe is not drivable here. `makeUnit` and `renderUnit` are the
 *   two pure functions that decide the surface, and they are what these assert.
 */

import { mulberry32 } from "@mailwoman/core/utils"
import { makeUnit, renderUnit, type UnitTuple } from "@mailwoman/corpus/recipes/unit"
import { describe, expect, it } from "vitest"

const TUPLE: UnitTuple = {
	house_number: "301",
	street: "College Ave",
	locality: "Athens",
	region: "GA",
	postcode: "30601",
	oaUnit: "101",
}

/**
 * Both builders draw from a caller-supplied stream, so a share is only observable across many streams.
 */
const over = <T>(n: number, f: (random: () => number) => T): T[] =>
	Array.from({ length: n }, (_, seed) => f(mulberry32(seed + 1)))

describe("makeUnit", () => {
	it("writes both `#101` and `# 101`", () => {
		const units = over(400, (random) => makeUnit(random, TUPLE.oaUnit))

		expect(units.some((u) => /^#\d/.test(u))).toBe(true)
		expect(units.some((u) => /^# \d/.test(u))).toBe(true)
	})

	it("keeps the word designators the majority", () => {
		const units = over(400, (random) => makeUnit(random, TUPLE.oaUnit))
		const sigil = units.filter((u) => u.startsWith("#")).length

		expect(sigil).toBeGreaterThan(0)
		expect(sigil).toBeLessThan(units.length / 2)
	})

	it("still writes the word designators", () => {
		const units = over(400, (random) => makeUnit(random, TUPLE.oaUnit))

		expect(units.some((u) => /^(Apt|Apartment)\b/.test(u))).toBe(true)
		expect(units.some((u) => /^(Ste|Suite)\b/.test(u))).toBe(true)
	})
})

describe("renderUnit", () => {
	it("writes the unit both comma-delimited and not", () => {
		const raws = over(400, (random) => renderUnit(random, TUPLE, "#101").raw)

		expect(raws.some((raw) => raw === "301 College Ave, #101, Athens, GA 30601")).toBe(true)
		expect(raws.some((raw) => raw === "301 College Ave #101, Athens, GA 30601")).toBe(true)
	})

	it("tags the sigil unit as `unit` and leaves the street name whole", () => {
		const comma = over(400, (random) => renderUnit(random, TUPLE, "#101")).filter((row) => row.fmt === "full-comma")

		expect(comma.length).toBeGreaterThan(0)
		expect(comma.every((row) => row.components.unit === "#101")).toBe(true)
		expect(comma.every((row) => row.components.street === "College Ave")).toBe(true)
	})

	it("holds every layout share except the one `full-comma` was carved from", () => {
		const rows = over(2000, (random) => renderUnit(random, TUPLE, "Apt 101"))
		const share = (fmt: string) => rows.filter((row) => row.fmt === fmt).length / rows.length

		expect(share("full-first")).toBeCloseTo(0.18, 1)
		expect(share("bare-after")).toBeCloseTo(0.16, 1)
		expect(share("bare-first")).toBeCloseTo(0.16, 1)
		expect(share("venue")).toBeCloseTo(0.16, 1)
	})

	it("writes the identifier with NO designator, in the comma layout only", () => {
		// The one unit surface carrying no token that decides its reading.
		// A bare id anywhere but between commas is indistinguishable from a house number,
		// so it is confined to this layout.
		const rows = over(2000, (random) => renderUnit(random, TUPLE, "Apt 101"))
		const bare = rows.filter((row) => row.fmt === "full-comma-bare")

		expect(bare.length).toBeGreaterThan(0)
		expect(bare.every((row) => row.components.unit === "101")).toBe(true)
		expect(bare.every((row) => row.raw.startsWith("301 College Ave, 101, Athens, GA"))).toBe(true)
		expect(rows.every((row) => row.fmt === "full-comma-bare" || !/, 101, /.test(row.raw))).toBe(true)
	})

	it("keeps the designator when the unit has no identifier to write bare", () => {
		// A standalone designator has nothing to strip to, so the layout keeps the
		// designator form rather than emitting a row with no unit at all.
		const rows = over(2000, (random) => renderUnit(random, TUPLE, "Basement"))

		expect(rows.every((row) => row.fmt !== "full-comma-bare")).toBe(true)
		expect(rows.every((row) => row.components.unit === "Basement")).toBe(true)
	})

	it("always returns a unit component that survives verbatim in the raw it rendered", () => {
		// The recipe drops a row whose unit component is not in its raw, because alignment could not label it.
		// That guard read the designator form handed IN, so a layout writing
		// anything else was skipped in silence.
		// Every `full-comma-bare` row, 1,160 of 50,000, until the guard was pointed at the rendered component.
		for (const unit of ["Apt 101", "#101", "# 101", "Basement", "Ste 4B"]) {
			const rows = over(500, (random) => renderUnit(random, TUPLE, unit))

			expect(rows.every((row) => row.components.unit && row.raw.includes(row.components.unit))).toBe(true)
		}
	})

	it("writes the postcode on its own comma segment on a minority of tails", () => {
		// The counter-reading of the bare unit.
		// Nothing else in the corpus writes a bare number alone in a later comma segment, so without
		// this the unit reading would be the only evidence for a segment users write a postcode into.
		const raws = over(2000, (random) => renderUnit(random, TUPLE, "Apt 101").raw)
		const commaPostcode = raws.filter((raw) => raw.includes("Athens, GA, 30601"))

		expect(commaPostcode.length).toBeGreaterThan(0)
		expect(commaPostcode.length).toBeLessThan(raws.length / 2)
		expect(raws.some((raw) => raw.includes("Athens, GA 30601"))).toBe(true)
	})
})
