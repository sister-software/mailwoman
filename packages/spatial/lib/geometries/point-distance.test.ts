/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { expect, test } from "vitest"

import { haversineKm } from "#distance"
import { greatCircleDistance, haversine } from "#geometries/point-distance"

// `[longitude, latitude]` tuples.
// The object form keeps the `(0, 0)` sentinel, so the equator pair starts ten degrees east of (0, 0).
test("greatCircleDistance takes the body radius: a quarter turn on the Moon is πR/2", () => {
	const quarter = greatCircleDistance([10, 0], [100, 0], { body: "moon" })

	expect(quarter).toBeCloseTo((Math.PI * 1737.4) / 2, 3)
	expect(greatCircleDistance([10, 0], [100, 0])).toBeCloseTo(haversine([10, 0], [100, 0]), 9)
})

test("haversine reads the object form and agrees with haversineKm away from (0, 0)", () => {
	expect(haversine([-74.006, 40.7128], [-0.1276, 51.5072])).toBeCloseTo(
		haversineKm(40.7128, -74.006, 51.5072, -0.1276),
		9
	)

	expect(haversine([-74.006, 40.7128], [-0.1276, 51.5072], "meters")).toBeCloseTo(
		haversineKm(40.7128, -74.006, 51.5072, -0.1276) * 1000,
		6
	)
})

test("haversine answers NaN for the (0, 0) sentinel", () => {
	expect(haversine([0, 0], [10, 10])).toBeNaN()
})
