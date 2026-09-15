/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file `unit` — the surfaces the slice must attest, and the layout shares it must preserve.
 *
 *   The recipe reads real OpenAddresses zips, so the slice is not drivable here. `makeUnit` and `renderUnit` are the
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
})
