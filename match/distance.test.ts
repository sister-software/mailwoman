/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"
import type { LatLon } from "./blocking.js"
import {
	DEFAULT_DISTANCE_LEVELS,
	DEFAULT_SPATIAL_LEVELS,
	distanceComparison,
	haversineKm,
	spatialComparison,
} from "./distance.js"

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

describe("spatialComparison (collapsed key + distance, A1)", () => {
	type R = { key?: string; coord?: LatLon }
	const cmp = spatialComparison<R>({
		name: "spatial",
		key: (r) => r.key,
		coordinate: (r) => r.coord,
		levels: DEFAULT_SPATIAL_LEVELS,
	})
	const rec = (key: string | undefined, latitude: number, longitude = 0): R => ({ key, coord: { latitude, longitude } })

	it("scores an exact canonical-key match as the top tier regardless of coordinate", () => {
		// Same key but the geocoder put them a hair apart — key equality is the evidence, not distance.
		expect(cmp.assess(rec("100 plaza dr", 29.76), rec("100 plaza dr", 29.7601))).toBe(0) // same-key
	})

	it("falls through to distance buckets when the keys DIFFER (the geo-first case)", () => {
		// Different canonical strings, same rooftop → near-agreement, not exact, not far.
		expect(cmp.assess(rec("123 main st", 45.5152), rec("123 main street apt 2", 45.5153))).toBe(1) // same-building
		expect(cmp.assess(rec("a", 0), rec("b", 0.003))).toBe(2) // ~0.33 km → same-block
		expect(cmp.assess(rec("a", 0), rec("b", 0.018))).toBe(3) // ~2 km → same-area
		expect(cmp.assess(rec("a", 0), rec("b", 1))).toBe(4) // ~111 km → far
	})

	it("yields no evidence when keys differ and a coordinate is missing", () => {
		expect(cmp.assess({ key: "a" }, { key: "b" })).toBe(-1)
		expect(cmp.assess(rec("a", 0), { key: "b" })).toBe(-1)
	})

	it("does not double-count: an exact key match banks one vote, not key + distance", () => {
		// The whole point of the collapse — there is a single spatial contribution, level 0.
		const index = cmp.assess(rec("100 plaza dr", 29.76), rec("100 plaza dr", 29.76))
		expect(index).toBe(0)
		expect(cmp.levels[index]!.label).toBe("same-key")
	})
})
