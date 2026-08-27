/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The ring blob: round-trip, containment with holes, and the two area readings the build compares.
 */

import {
	decodeRings,
	encodeRings,
	pointInEncodedRings,
	ringAreaReadings,
	ringSignedAreaM2,
} from "@mailwoman/flood/rings"
import { holeRing, rectangleRing } from "@mailwoman/flood/test-kit"
import { pointInPolygonRings } from "@mailwoman/spatial"
import { describe, expect, it } from "vitest"

describe("ring blob", () => {
	it("round-trips a multi-polygon's rings, keeping the polygon grouping", () => {
		const polygons = [[rectangleRing(0, 0, 1, 1), holeRing(0.25, 0.25, 0.75, 0.75)], [rectangleRing(3, 3, 4, 4)]]

		const decoded = decodeRings(encodeRings(polygons))

		expect(decoded.polygons).toHaveLength(2)
		expect(decoded.polygons[0]).toHaveLength(2)
		expect(decoded.polygons[1]).toHaveLength(1)
		expect(decoded.polygons[0]![0]).toEqual(polygons[0]![0]!.flat())
	})

	it("refuses a blob whose declared ring table does not account for its bytes", () => {
		const blob = encodeRings([[rectangleRing(0, 0, 1, 1)]])

		expect(() => pointInEncodedRings(blob.slice(0, blob.byteLength - 8), 0.5, 0.5)).toThrow(/holds/u)
	})

	it("answers containment the same way the shared ray cast does — hole included", () => {
		const rings = [rectangleRing(0, 0, 1, 1), holeRing(0.25, 0.25, 0.75, 0.75)]
		const blob = encodeRings([rings])

		for (const [lon, lat, expected] of [
			[0.1, 0.1, true],
			[0.5, 0.5, false],
			[0.9, 0.5, true],
			[2, 2, false],
		] as Array<[number, number, boolean]>) {
			expect(pointInEncodedRings(blob, lon, lat)).toBe(expected)
			expect(pointInPolygonRings(lon, lat, rings as [number, number][][])).toBe(expected)
		}
	})

	it("keeps two polygons of one feature apart, so a point in either is inside", () => {
		const blob = encodeRings([[rectangleRing(0, 0, 1, 1)], [rectangleRing(3, 3, 4, 4)]])

		expect(pointInEncodedRings(blob, 0.5, 0.5)).toBe(true)
		expect(pointInEncodedRings(blob, 3.5, 3.5)).toBe(true)
		expect(pointInEncodedRings(blob, 2, 2)).toBe(false)
	})
})

describe("ring areas", () => {
	it("signs a ring by its winding, which is what lets a hole subtract", () => {
		const outer = ringSignedAreaM2(rectangleRing(0, 0, 0.01, 0.01))
		const hole = ringSignedAreaM2(holeRing(0, 0, 0.01, 0.01))

		expect(Math.sign(outer)).not.toBe(Math.sign(hole))
		expect(Math.abs(outer)).toBeCloseTo(Math.abs(hole), 6)
	})

	it("reports the hole-blind reading beside the nested one, and it is larger", () => {
		const polygons = [[rectangleRing(0, 0, 0.01, 0.01), holeRing(0.004, 0.004, 0.006, 0.006)]]
		const { nested, allExterior } = ringAreaReadings(polygons)

		expect(allExterior).toBeGreaterThan(nested)
		// The hole is a fifth of the square's side each way, so a hole-blind read over-reports by twice its area: it adds
		// the hole where the nested reading subtracts it.
		expect(allExterior - nested).toBeCloseTo(2 * Math.abs(ringSignedAreaM2(holeRing(0.004, 0.004, 0.006, 0.006))), 3)
	})

	it("does not let two disjoint polygons of one feature cancel each other", () => {
		const clockwise = holeRing(0, 0, 0.01, 0.01)
		const counterClockwise = rectangleRing(1, 1, 1.01, 1.01)
		const { nested } = ringAreaReadings([[clockwise], [counterClockwise]])

		expect(nested).toBeCloseTo(Math.abs(ringSignedAreaM2(clockwise)) + Math.abs(ringSignedAreaM2(counterClockwise)), 3)
	})
})
