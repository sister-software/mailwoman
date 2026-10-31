/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { expect, test } from "vitest"

import { haversine } from "#geometries/point/distance"

// Earth mean radius the formula uses (EARTH_RADII.km).
// Reference distances below are derived from it rather than looked up — so they pin
// the exact constant + formula rather than an approximation.
const R = 6371

test("haversine: a point to itself is zero", () => {
	expect(haversine(40.7128, -74.006, 40.7128, -74.006)).toBe(0)
})

test("haversine: one degree along the equator / a meridian is R·(π/180)", () => {
	const oneDegree = (R * Math.PI) / 180 // ≈ 111.195 km
	expect(haversine(0, 0, 0, 1)).toBeCloseTo(oneDegree, 3) // 1° longitude at the equator
	expect(haversine(0, 0, 1, 0)).toBeCloseTo(oneDegree, 3) // 1° latitude along a meridian
})

test("haversine: antipodal points are half the great circle (R·π)", () => {
	expect(haversine(0, 0, 0, 180)).toBeCloseTo(R * Math.PI, 2) // ≈ 20015.09 km
})

test("haversine: a real-world pair lands in the right ballpark (NYC ↔ LA)", () => {
	const d = haversine(40.7128, -74.006, 34.0522, -118.2437)
	expect(d).toBeGreaterThan(3900)
	expect(d).toBeLessThan(3970) // ~3936 km
})

test("haversine: symmetric in its arguments", () => {
	const ab = haversine(51.5074, -0.1278, 48.8566, 2.3522) // London → Paris
	const ba = haversine(48.8566, 2.3522, 51.5074, -0.1278)
	expect(ab).toBeCloseTo(ba, 10)
	expect(ab).toBeGreaterThan(330)
	expect(ab).toBeLessThan(355) // ~343 km
})

test("haversine: (0,0) is a real point (Gulf of Guinea), not a missing-coordinate sentinel", () => {
	// Unlike the `GeoPointInput` form, the scalar form has no Null-Island sentinel —
	// 0/0 is a real coordinate, so this returns a finite distance rather than NaN.
	const d = haversine(0, 0, 0.5, 0.5)
	expect(Number.isNaN(d)).toBe(false)
	expect(d).toBeGreaterThan(0)
})
