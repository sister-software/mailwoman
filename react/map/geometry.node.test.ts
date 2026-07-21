/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   PURE geometry tests — bare node, no map, no DOM. They exercise the circle-ring + bounds math the demo
 *   outline draws with, including the edge cases the imperative `_map-helpers.ts` handled: a single point
 *   (no bbox → default radius), a degenerate bbox (zero span → clamped floor), an over-large bbox
 *   (clamped ceiling), a sub-visible radius (meter floor), MultiPolygon bounds, and the DOCUMENTED
 *   non-normalization of antimeridian-crossing geometry.
 */

import { expect, test } from "vitest"

import { approxCircleGeometry, bboxToBounds, geomBounds, type PlaceGeometry, radiusCircleGeometry } from "./geometry.ts"

const KM_PER_DEG_LAT = 111.32

/** Recover a centered circle's radius (km) from the latitude half-span of its ring — no cos() needed on latitude. */
function circleRadiusKm(geometry: PlaceGeometry): number {
	const b = geomBounds(geometry)

	return ((b.maxLat - b.minLat) / 2) * KM_PER_DEG_LAT
}

test("approxCircleGeometry with no bbox uses the ~3 km default radius and a closed 65-point ring", () => {
	const geom = approxCircleGeometry(40, -74)

	expect(geom.type).toBe("Polygon")
	const ring = geom.coordinates[0] as number[][]
	expect(ring).toHaveLength(65)
	// theta=0 and theta=2π coincide → the ring is closed.
	expect(ring[0]![0]).toBeCloseTo(ring[64]![0]!, 9)
	expect(ring[0]![1]).toBeCloseTo(ring[64]![1]!, 9)
	expect(circleRadiusKm(geom)).toBeCloseTo(3, 2)
})

test("approxCircleGeometry sizes the radius from the bbox half-diagonal", () => {
	// 0.1°×0.1° at lat 40 → hypot(0.1·111.32, 0.1·111.32·cos40)/2 ≈ 7.01 km.
	const geom = approxCircleGeometry(40, -74, { minLat: 39.95, maxLat: 40.05, minLon: -74.05, maxLon: -73.95 })
	expect(circleRadiusKm(geom)).toBeCloseTo(7.01, 1)
})

test("approxCircleGeometry clamps a degenerate (zero-span) bbox up to the 0.5 km floor", () => {
	const geom = approxCircleGeometry(40, -74, { minLat: 40, maxLat: 40, minLon: -74, maxLon: -74 })
	expect(circleRadiusKm(geom)).toBeCloseTo(0.5, 3)
})

test("approxCircleGeometry clamps an over-large bbox down to the 50 km ceiling", () => {
	const geom = approxCircleGeometry(0, 0, { minLat: -20, maxLat: 20, minLon: -20, maxLon: 20 })
	expect(circleRadiusKm(geom)).toBeCloseTo(50, 2)
})

test("radiusCircleGeometry honors an exact meter radius", () => {
	const geom = radiusCircleGeometry(40, -74, 1000) // 1 km
	expect(circleRadiusKm(geom)).toBeCloseTo(1, 3)
})

test("radiusCircleGeometry floors a sub-visible radius to ~8 m so a 10 m situs circle stays drawable", () => {
	expect(circleRadiusKm(radiusCircleGeometry(40, -74, 5))).toBeCloseTo(0.008, 4)
	expect(circleRadiusKm(radiusCircleGeometry(40, -74, 10))).toBeCloseTo(0.01, 4)
})

test("geomBounds walks a single-ring Polygon", () => {
	const geom: PlaceGeometry = {
		type: "Polygon",
		coordinates: [
			[
				[-74, 40],
				[-73, 40],
				[-73, 41],
				[-74, 41],
				[-74, 40],
			],
		],
	}
	expect(geomBounds(geom)).toEqual({ minLon: -74, minLat: 40, maxLon: -73, maxLat: 41 })
})

test("geomBounds walks every part of a MultiPolygon", () => {
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
					[10, 10],
					[12, 10],
					[12, 13],
					[10, 10],
				],
			],
		],
	}
	expect(geomBounds(geom)).toEqual({ minLon: 0, minLat: 0, maxLon: 12, maxLat: 13 })
})

test("geomBounds collapses a single-vertex (degenerate) polygon to a zero-area box", () => {
	const geom: PlaceGeometry = { type: "Polygon", coordinates: [[[5, 7]]] }
	expect(geomBounds(geom)).toEqual({ minLon: 5, minLat: 7, maxLon: 5, maxLat: 7 })
})

test("geomBounds does NOT normalize an antimeridian-crossing polygon (documents the naive min/max)", () => {
	// A ring spanning 179°E → -179°E: the naive bounds report the full -179..179 span, NOT the ~2° real one.
	const geom: PlaceGeometry = {
		type: "Polygon",
		coordinates: [
			[
				[179, 0],
				[-179, 0],
				[-179, 1],
				[179, 1],
				[179, 0],
			],
		],
	}
	expect(geomBounds(geom)).toEqual({ minLon: -179, minLat: 0, maxLon: 179, maxLat: 1 })
})

test("bboxToBounds reshapes an object bbox into the [[minLon,minLat],[maxLon,maxLat]] fitBounds pair", () => {
	expect(bboxToBounds({ minLat: 40, maxLat: 41, minLon: -74, maxLon: -73 })).toEqual([
		[-74, 40],
		[-73, 41],
	])
})
