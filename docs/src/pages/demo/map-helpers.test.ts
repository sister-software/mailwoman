/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Unit tests for the pure geometry helpers extracted from the demo page. These need no DOM/map, so
 *   they run under the repo-root vitest like any other workspace unit test.
 */

import { describe, expect, test } from "vitest"

import { approxCircleGeometry, geomBounds, type PlaceGeometry } from "./_map-helpers.js"

describe("geomBounds", () => {
	test("computes the bounding box of a simple polygon ring", () => {
		const geom: PlaceGeometry = {
			type: "Polygon",
			coordinates: [
				[
					[-10, -5],
					[10, -5],
					[10, 5],
					[-10, 5],
					[-10, -5],
				],
			],
		}
		expect(geomBounds(geom)).toEqual({ minLon: -10, minLat: -5, maxLon: 10, maxLat: 5 })
	})

	test("walks every ring of a MultiPolygon", () => {
		const geom: PlaceGeometry = {
			type: "MultiPolygon",
			coordinates: [
				[
					[
						[0, 0],
						[1, 0],
						[1, 1],
						[0, 0],
					],
				],
				[
					[
						[5, 5],
						[8, 5],
						[8, 9],
						[5, 5],
					],
				],
			],
		}
		expect(geomBounds(geom)).toEqual({ minLon: 0, minLat: 0, maxLon: 8, maxLat: 9 })
	})
})

describe("approxCircleGeometry", () => {
	test("returns a closed 64-segment ring centered on the point", () => {
		const geom = approxCircleGeometry(40, -74)
		expect(geom.type).toBe("Polygon")
		const ring = (geom as { coordinates: number[][][] }).coordinates[0]
		// 64 segments → 65 vertices, first === last (closed).
		expect(ring).toHaveLength(65)
		expect(ring[0]).toEqual(ring[64])
		// A symmetric circle: the bounding-box midpoint is exactly the input point.
		const { minLon, maxLon, minLat, maxLat } = geomBounds(geom)
		expect((minLon + maxLon) / 2).toBeCloseTo(-74, 6)
		expect((minLat + maxLat) / 2).toBeCloseTo(40, 6)
	})

	test("defaults to a ~3 km radius when no bbox is supplied", () => {
		const { minLat, maxLat } = geomBounds(approxCircleGeometry(0, 0))
		// 3 km / 111.32 km-per-deg ≈ 0.02695°, so the lat span ≈ 0.0539°.
		expect((maxLat - minLat) / 2).toBeCloseTo(3 / 111.32, 3)
	})

	test("clamps the radius to the 0.5–50 km band", () => {
		// A degenerate (zero-extent) bbox would compute radius 0 → clamps up to 0.5 km.
		const tiny = geomBounds(approxCircleGeometry(0, 0, { minLat: 0, maxLat: 0, minLon: 0, maxLon: 0 }))
		expect((tiny.maxLat - tiny.minLat) / 2).toBeCloseTo(0.5 / 111.32, 3)

		// A continent-sized bbox clamps down to 50 km.
		const huge = geomBounds(approxCircleGeometry(0, 0, { minLat: -40, maxLat: 40, minLon: -60, maxLon: 60 }))
		expect((huge.maxLat - huge.minLat) / 2).toBeCloseTo(50 / 111.32, 3)
	})
})
