/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { expect, test } from "vitest"

import type { GeojsonPosition } from "./geo.ts"
import { bboxAround, geometryContains, pointInPolygonRings, pointInRing } from "./geo.ts"

// A unit square ring in [lon, lat], closed.
const SQUARE: GeojsonPosition[] = [
	[0, 0],
	[0, 1],
	[1, 1],
	[1, 0],
	[0, 0],
]

test("pointInRing: inside vs outside a simple ring (ray-cast even-odd)", () => {
	expect(pointInRing(0.5, 0.5, SQUARE)).toBe(true)
	expect(pointInRing(2, 0.5, SQUARE)).toBe(false) // east of the ring
	expect(pointInRing(-1, 0.5, SQUARE)).toBe(false) // west of the ring
	expect(pointInRing(0.5, 2, SQUARE)).toBe(false) // north of the ring
})

test("pointInPolygonRings: a hole punches a void (even-odd handles holes, no orientation rules)", () => {
	const outer: GeojsonPosition[] = [
		[0, 0],
		[0, 10],
		[10, 10],
		[10, 0],
		[0, 0],
	]
	const hole: GeojsonPosition[] = [
		[4, 4],
		[4, 6],
		[6, 6],
		[6, 4],
		[4, 4],
	]
	// inside outer, NOT in the hole → contained
	expect(pointInPolygonRings(1, 1, [outer, hole])).toBe(true)
	// inside the hole → an odd-count void → NOT contained
	expect(pointInPolygonRings(5, 5, [outer, hole])).toBe(false)
	// outside everything
	expect(pointInPolygonRings(20, 20, [outer, hole])).toBe(false)
})

test("geometryContains: Polygon / MultiPolygon test; non-areal and null geometry → null", () => {
	const polygon = { type: "Polygon" as const, coordinates: [SQUARE] }
	expect(geometryContains(polygon, 0.5, 0.5)).toBe(true)
	expect(geometryContains(polygon, 5, 5)).toBe(false)

	const multi = {
		type: "MultiPolygon" as const,
		coordinates: [
			[SQUARE],
			[
				[
					[10, 10],
					[10, 11],
					[11, 11],
					[11, 10],
					[10, 10],
				] as GeojsonPosition[],
			],
		],
	}
	expect(geometryContains(multi, 0.5, 0.5)).toBe(true) // in the first polygon
	expect(geometryContains(multi, 10.5, 10.5)).toBe(true) // in the second polygon
	expect(geometryContains(multi, 5, 5)).toBe(false) // in neither

	// non-areal / missing → null (the "no polygon on record" fallback, never a rejection)
	expect(geometryContains({ type: "Point", coordinates: [0.5, 0.5] }, 0.5, 0.5)).toBeNull()
	expect(geometryContains(null, 0.5, 0.5)).toBeNull()
	expect(geometryContains(undefined, 0.5, 0.5)).toBeNull()
})

test("bboxAround: symmetric box; longitude widens with latitude (1/cos)", () => {
	const eq = bboxAround(0, 0, 111) // ~1° each way at the equator
	expect(eq.maxLat - eq.minLat).toBeCloseTo(2, 5) // 2 × (111/111)
	expect(eq.maxLon - eq.minLon).toBeCloseTo(2, 5) // cos(0)=1 → same as lat span
	expect(eq.minLat).toBeCloseTo(-1, 5)

	// at 60°N, cos(60°)=0.5 → longitude span doubles relative to latitude span
	const hi = bboxAround(60, 0, 111)
	expect(hi.maxLon - hi.minLon).toBeCloseTo(4, 3)
	expect(hi.maxLat - hi.minLat).toBeCloseTo(2, 5)
})
