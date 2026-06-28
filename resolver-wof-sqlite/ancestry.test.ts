/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { expect, test } from "vitest"

import { PLACETYPE_DEPTH, placetypeDepth } from "./ancestry.js"

// `ancestorLineage` takes a live `DatabaseSync` handle + queries `ancestors`/`spr`, so it's out of
// scope for a pure unit test. Only the depth helpers below are value-in/value-out.

test("placetypeDepth: coarsest → finest containment ordering, country=1 up to microhood=11", () => {
	expect(placetypeDepth("country")).toBe(1)
	expect(placetypeDepth("region")).toBe(3)
	expect(placetypeDepth("county")).toBe(5)
	expect(placetypeDepth("localadmin")).toBe(6)
	expect(placetypeDepth("locality")).toBe(7)
	expect(placetypeDepth("microhood")).toBe(11)
})

test("placetypeDepth: depth strictly increases from country down to microhood", () => {
	const order = [
		"country",
		"macroregion",
		"region",
		"macrocounty",
		"county",
		"localadmin",
		"locality",
		"borough",
		"macrohood",
		"neighbourhood",
		"microhood",
	]
	const depths = order.map(placetypeDepth)

	for (let i = 1; i < depths.length; i++) {
		expect(depths[i]).toBeGreaterThan(depths[i - 1]!)
	}
})

test("placetypeDepth: unknown / never-resolved placetypes map to 0 (sort coarsest)", () => {
	// continent, empire, planet, … are deliberately absent → 0 so they sort last (coarsest).
	expect(placetypeDepth("continent")).toBe(0)
	expect(placetypeDepth("empire")).toBe(0)
	expect(placetypeDepth("")).toBe(0)
	expect(placetypeDepth("not-a-placetype")).toBe(0)
	// A finer placetype always out-ranks an unknown one.
	expect(placetypeDepth("locality")).toBeGreaterThan(placetypeDepth("continent"))
})

test("placetypeDepth: descending-depth sort yields nearest-first (deepest placetype first)", () => {
	// The lineage walk sorts by placetypeDepth(b) - placetypeDepth(a); reproduce that ordering.
	const mixed = ["country", "neighbourhood", "region", "locality"]
	const nearestFirst = [...mixed].sort((a, b) => placetypeDepth(b) - placetypeDepth(a))
	expect(nearestFirst).toEqual(["neighbourhood", "locality", "region", "country"])
})

test("PLACETYPE_DEPTH: the exported table matches placetypeDepth for every known key", () => {
	for (const [placetype, depth] of Object.entries(PLACETYPE_DEPTH)) {
		expect(placetypeDepth(placetype)).toBe(depth)
	}
	// Each depth is unique (no two placetypes collide at the same rank).
	const depths = Object.values(PLACETYPE_DEPTH)
	expect(new Set(depths).size).toBe(depths.length)
})
