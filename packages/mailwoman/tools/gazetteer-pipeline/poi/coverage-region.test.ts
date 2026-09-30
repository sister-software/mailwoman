/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Unit cover for the region → coverage-cell derivation. The property under test is not "how many cells"
 *   but "no cell that pokes outside the region" — the one that decides whether a completeness claim covers
 *   ground the source never saw.
 */

import {
	type LineStringPath,
	type ParsedGeometry,
	type PolygonRings,
	geometryBBox,
	interiorCoverageCells,
	interiorCoverageCellSet,
	regionCoverageCells,
	geometryContains,
} from "@mailwoman/spatial"
import { cellToBoundary } from "h3-js"
import { describe, expect, it } from "vitest"

/**
 * A lon/lat square, counter-clockwise and closed.
 */
function square(minLon: number, minLat: number, size: number): ParsedGeometry {
	const ring: LineStringPath = [
		[minLon, minLat],
		[minLon + size, minLat],
		[minLon + size, minLat + size],
		[minLon, minLat + size],
		[minLon, minLat],
	]

	return { type: "Polygon", coordinates: [ring] }
}

/**
 * One degree square over the Paris basin, large enough at res 6 to have a real interior.
 */
const REGION = square(2, 48.5, 1)

describe("regionCoverageCells", () => {
	it("polyfills a polygon", () => {
		expect(regionCoverageCells(REGION, 6).length).toBeGreaterThan(100)
	})

	it("polyfills every polygon of a MultiPolygon", () => {
		const single = regionCoverageCells(square(2, 48.5, 0.3), 6)

		const multi = regionCoverageCells(
			{
				type: "MultiPolygon",
				coordinates: [
					(square(2, 48.5, 0.3) as { coordinates: PolygonRings }).coordinates,
					(square(6, 48.5, 0.3) as { coordinates: PolygonRings }).coordinates,
				],
			},
			6
		)

		expect(multi.length).toBeGreaterThan(single.length)
	})

	it("refuses a geometry that is not a polygon", () => {
		const point: ParsedGeometry = { type: "Point", coordinates: [2, 48] }

		expect(() => regionCoverageCells(point, 6)).toThrow(/Polygon or MultiPolygon/)
	})
})

describe("interiorCoverageCells", () => {
	it("is a strict subset of the polyfill", () => {
		const polyfilled = regionCoverageCells(REGION, 6)
		const interior = interiorCoverageCells(REGION, 6)

		expect(interior.length).toBeGreaterThan(0)
		expect(interior.length).toBeLessThan(polyfilled.length)
		expect(new Set(polyfilled).isSupersetOf(new Set(interior))).toBe(true)
	})

	it("returns only cells whose every vertex is inside the region", () => {
		for (const cell of interiorCoverageCells(REGION, 6)) {
			for (const [lat, lon] of cellToBoundary(cell) as number[][]) {
				expect(geometryContains(REGION, lon!, lat!)).toBe(true)
			}
		}
	})

	it("is empty when the region is smaller than a cell", () => {
		expect(interiorCoverageCells(square(2, 48.5, 0.001), 6)).toHaveLength(0)
	})

	it("keeps a hole out of the interior", () => {
		const outer = (square(2, 48.5, 1) as { coordinates: PolygonRings }).coordinates[0]!
		const hole = (square(2.4, 48.9, 0.2) as { coordinates: PolygonRings }).coordinates[0]!
		const holed: ParsedGeometry = { type: "Polygon", coordinates: [outer, hole] }
		const solid = new Set(interiorCoverageCells(REGION, 6))
		const punched = new Set(interiorCoverageCells(holed, 6))

		expect(punched.size).toBeLessThan(solid.size)

		for (const cell of punched) {
			for (const [lat, lon] of cellToBoundary(cell) as number[][]) {
				expect(geometryContains(holed, lon!, lat!)).toBe(true)
			}
		}
	})
})

describe("interiorCoverageCellSet", () => {
	it("carries one short cell per interior cell", () => {
		expect(interiorCoverageCellSet(REGION, 6).size).toBe(interiorCoverageCells(REGION, 6).length)
	})
})

describe("geometryBBox", () => {
	it("bounds the region", () => {
		expect(geometryBBox(REGION)).toEqual({ minLon: 2, minLat: 48.5, maxLon: 3, maxLat: 49.5 })
	})

	it("spans every polygon of a MultiPolygon", () => {
		const multi: ParsedGeometry = {
			type: "MultiPolygon",
			coordinates: [
				(square(2, 48.5, 0.3) as { coordinates: PolygonRings }).coordinates,
				(square(6, 50, 0.3) as { coordinates: PolygonRings }).coordinates,
			],
		}

		expect(geometryBBox(multi)).toEqual({ minLon: 2, minLat: 48.5, maxLon: 6.3, maxLat: 50.3 })
	})
})
