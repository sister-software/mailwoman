/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"
import type { LatLon } from "./blocking.js"
import { DEFAULT_DISTANCE_LEVELS, distanceComparison, haversineKm } from "./distance.js"

describe("haversineKm", () => {
	it("is 0 for identical points", () => {
		expect(haversineKm({ latitude: 45, longitude: -122 }, { latitude: 45, longitude: -122 })).toBe(0)
	})

	it("is ~111.2 km per degree of latitude", () => {
		expect(haversineKm({ latitude: 0, longitude: 0 }, { latitude: 1, longitude: 0 })).toBeCloseTo(111.2, 0)
	})

	it("matches a known city pair (Portland ↔ Seattle ≈ 234 km)", () => {
		const km = haversineKm({ latitude: 45.5152, longitude: -122.6784 }, { latitude: 47.6062, longitude: -122.3321 })
		expect(km).toBeGreaterThan(230)
		expect(km).toBeLessThan(240)
	})
})

describe("distanceComparison", () => {
	type R = { coord?: LatLon }
	const cmp = distanceComparison<R>({ name: "geo", extract: (r) => r.coord, levels: DEFAULT_DISTANCE_LEVELS })
	const at = (latitude: number) => ({ coord: { latitude, longitude: 0 } })

	it("buckets distance into the right agreement level, nearest first", () => {
		expect(cmp.assess(at(0), at(0))).toBe(0) // same building (0 km)
		expect(cmp.assess(at(0), at(0.003))).toBe(1) // ~0.33 km → same block
		expect(cmp.assess(at(0), at(0.018))).toBe(2) // ~2 km → same area
		expect(cmp.assess(at(0), at(1))).toBe(3) // ~111 km → far
	})

	it("yields no evidence when a coordinate is missing or invalid", () => {
		expect(cmp.assess(at(0), {})).toBe(-1)
		expect(cmp.assess(at(0), { coord: { latitude: NaN, longitude: 0 } })).toBe(-1)
	})
})
