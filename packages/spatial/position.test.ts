/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { haversineKm } from "@mailwoman/spatial"
import { expect, test } from "vitest"

// Earth mean radius the formula uses (RADII.km). Reference distances below are derived from it, not
// looked up — so they pin the exact constant + formula, not an approximation.
const R = 6371

test("haversineKm: a point to itself is zero", () => {
	expect(haversineKm(40.7128, -74.006, 40.7128, -74.006)).toBe(0)
})

test("haversineKm: one degree along the equator / a meridian is R·(π/180)", () => {
	const oneDegree = (R * Math.PI) / 180 // ≈ 111.195 km
	expect(haversineKm(0, 0, 0, 1)).toBeCloseTo(oneDegree, 3) // 1° longitude at the equator
	expect(haversineKm(0, 0, 1, 0)).toBeCloseTo(oneDegree, 3) // 1° latitude along a meridian
})

test("haversineKm: antipodal points are half the great circle (R·π)", () => {
	expect(haversineKm(0, 0, 0, 180)).toBeCloseTo(R * Math.PI, 2) // ≈ 20015.09 km
})

test("haversineKm: a real-world pair lands in the right ballpark (NYC ↔ LA)", () => {
	const d = haversineKm(40.7128, -74.006, 34.0522, -118.2437)
	expect(d).toBeGreaterThan(3900)
	expect(d).toBeLessThan(3970) // ~3936 km
})

test("haversineKm: symmetric in its arguments", () => {
	const ab = haversineKm(51.5074, -0.1278, 48.8566, 2.3522) // London → Paris
	const ba = haversineKm(48.8566, 2.3522, 51.5074, -0.1278)
	expect(ab).toBeCloseTo(ba, 10)
	expect(ab).toBeGreaterThan(330)
	expect(ab).toBeLessThan(355) // ~343 km
})

test("haversineKm: (0,0) is a real point (Gulf of Guinea), not a missing-coordinate sentinel", () => {
	// Unlike the object-form `haversine`, the raw-scalar form has no Null-Island sentinel — 0/0 is a
	// real coordinate, so this returns a finite distance rather than NaN.
	const d = haversineKm(0, 0, 0.5, 0.5)
	expect(Number.isNaN(d)).toBe(false)
	expect(d).toBeGreaterThan(0)
})
