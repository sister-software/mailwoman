/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { expect, test } from "vitest"

import { greatCircleDistance, haversine } from "#geometries/point/distance"

// `[longitude, latitude]` tuples.
// The object form keeps the `(0, 0)` sentinel, so the equator pair starts ten degrees east of (0, 0).
test("greatCircleDistance takes the body radius: a quarter turn on the Moon is πR/2", () => {
	const quarter = greatCircleDistance([10, 0], [100, 0], { body: "moon" })

	expect(quarter).toBeCloseTo((Math.PI * 1737.4) / 2, 3)
	expect(greatCircleDistance([10, 0], [100, 0])).toBeCloseTo(haversine([10, 0], [100, 0]), 9)
})

test("haversine agrees between its object and scalar forms away from (0, 0)", () => {
	expect(haversine([-74.006, 40.7128], [-0.1276, 51.5072])).toBeCloseTo(
		haversine(40.7128, -74.006, 51.5072, -0.1276),
		9
	)

	expect(haversine([-74.006, 40.7128], [-0.1276, 51.5072], "meters")).toBeCloseTo(
		haversine(40.7128, -74.006, 51.5072, -0.1276) * 1000,
		6
	)
})

test("haversine answers NaN for the (0, 0) sentinel", () => {
	expect(haversine([0, 0], [10, 10])).toBeNaN()
})

test("haversine scalar form takes a unit and treats (0, 0) as a real point", () => {
	expect(haversine(0, 0, 0, 1, "meters")).toBeCloseTo(haversine(0, 0, 0, 1) * 1000, 6)
	expect(haversine(0, 0, 0, 1)).toBeGreaterThan(0)
})

test("haversine scalar form answers null for an absent component", () => {
	const lat: number | null = null as number | null

	expect(haversine(lat, 10, 20, 30)).toBeNull()
	expect(haversine(10, 20, undefined, 30)).toBeNull()
	expect(haversine(10 as number | null, 20, 30, 40)).toBeGreaterThan(0)
})
