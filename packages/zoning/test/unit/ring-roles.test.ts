/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The hole-role resolution, pinned against the convention it depends on.
 *
 *   THE SIGN CONVENTION IS A CONTRACT AND IT IS PINNED FIRST. `ringSignedAreaM2` signs CLOCKWISE positive,
 *   which is the opposite of the standard planar shoelace, and this resolver reads a ring's role off that
 *   sign. A change to the helper that flipped it would turn every exterior into a hole and every hole into an
 *   exterior — and the resulting polygons would still be well-formed, still answer containment questions, and
 *   still be wrong everywhere.
 *
 *   THE REST IS THE PUBLISHER'S ENCODING. This service puts each ring in its own `MultiPolygon` part on the
 *   features that carry holes that way, so a reader taking the arriving nesting at face value reads a hole as
 *   a second zoned area. Every case below arrives in that shape.
 */

import { resolveRingRoles } from "@mailwoman/zoning/ring-roles"
import { pointInEncodedRings, encodeRings, ringAreaReadings, ringSignedAreaM2 } from "@mailwoman/zoning/rings"
import { exteriorRing, holeRing } from "@mailwoman/zoning/test-kit"
import { describe, expect, it } from "vitest"

const ORIGIN = { lon: -6.5, lat: 53.4 } as const
const SIDE = 0.01

describe("the sign convention this resolver reads roles from", () => {
	it("signs a clockwise ring POSITIVE and a counter-clockwise one negative", () => {
		// Clockwise is the EXTERIOR under this service, so this is the statement the whole resolution rests on. The two ring
		// builders are `@mailwoman/spatial`'s own, aliased by the test-kit to this product's meaning.
		expect(
			ringSignedAreaM2(exteriorRing(ORIGIN.lon, ORIGIN.lat, ORIGIN.lon + SIDE, ORIGIN.lat + SIDE))
		).toBeGreaterThan(0)

		expect(ringSignedAreaM2(holeRing(ORIGIN.lon, ORIGIN.lat, ORIGIN.lon + SIDE, ORIGIN.lat + SIDE))).toBeLessThan(0)
	})

	it("gives a ring and its reverse the same magnitude", () => {
		const clockwise = ringSignedAreaM2(exteriorRing(ORIGIN.lon, ORIGIN.lat, ORIGIN.lon + SIDE, ORIGIN.lat + SIDE))
		const counter = ringSignedAreaM2(holeRing(ORIGIN.lon, ORIGIN.lat, ORIGIN.lon + SIDE, ORIGIN.lat + SIDE))

		expect(Math.abs(clockwise)).toBeCloseTo(Math.abs(counter), 6)
	})
})

describe("resolveRingRoles", () => {
	it("reads a lone clockwise ring as one exterior with no holes", () => {
		const resolved = resolveRingRoles(
			[[exteriorRing(ORIGIN.lon, ORIGIN.lat, ORIGIN.lon + SIDE, ORIGIN.lat + SIDE)]],
			"1"
		)

		expect(resolved.exteriorCount).toBe(1)
		expect(resolved.holeCount).toBe(0)
		expect(resolved.ringCount).toBe(1)
		expect(resolved.polygons).toHaveLength(1)
		expect(resolved.polygons[0]).toHaveLength(1)
		expect(resolved.signedAreaM2).toBeGreaterThan(0)
	})

	it("nests a hole arriving as its OWN MultiPolygon part, which is how this service publishes one", () => {
		// The trap in one case: the source hands two single-ring parts, and a reader that kept the arriving nesting would
		// store two zoned areas covering the same ground.
		const resolved = resolveRingRoles(
			[
				[exteriorRing(ORIGIN.lon, ORIGIN.lat, ORIGIN.lon + SIDE, ORIGIN.lat + SIDE)],
				[holeRing(ORIGIN.lon + SIDE * 0.3, ORIGIN.lat + SIDE * 0.3, ORIGIN.lon + SIDE * 0.7, ORIGIN.lat + SIDE * 0.7)],
			],
			"2"
		)

		expect(resolved.exteriorCount).toBe(1)
		expect(resolved.holeCount).toBe(1)
		expect(resolved.nestedHoles).toBe(1)
		expect(resolved.adjacentHoles).toBe(0)
		// ONE polygon carrying TWO rings — the shape the ring blob's point test needs to answer a hole correctly.
		expect(resolved.polygons).toHaveLength(1)
		expect(resolved.polygons[0]).toHaveLength(2)
	})

	it("answers a point inside that hole as OUTSIDE the polygon, which is the harmful half of getting this wrong", () => {
		const resolved = resolveRingRoles(
			[
				[exteriorRing(ORIGIN.lon, ORIGIN.lat, ORIGIN.lon + SIDE, ORIGIN.lat + SIDE)],
				[holeRing(ORIGIN.lon + SIDE * 0.3, ORIGIN.lat + SIDE * 0.3, ORIGIN.lon + SIDE * 0.7, ORIGIN.lat + SIDE * 0.7)],
			],
			"3"
		)

		const blob = encodeRings(resolved.polygons)

		expect(pointInEncodedRings(blob, ORIGIN.lon + SIDE * 0.5, ORIGIN.lat + SIDE * 0.5)).toBe(false)
		expect(pointInEncodedRings(blob, ORIGIN.lon + SIDE * 0.1, ORIGIN.lat + SIDE * 0.1)).toBe(true)
	})

	it("subtracts the hole from the area and reports the hole-blind reading beside it", () => {
		const resolved = resolveRingRoles(
			[
				[exteriorRing(ORIGIN.lon, ORIGIN.lat, ORIGIN.lon + SIDE, ORIGIN.lat + SIDE)],
				[holeRing(ORIGIN.lon + SIDE * 0.3, ORIGIN.lat + SIDE * 0.3, ORIGIN.lon + SIDE * 0.7, ORIGIN.lat + SIDE * 0.7)],
			],
			"4"
		)

		const { nested, allExterior } = ringAreaReadings(resolved.polygons)

		expect(allExterior).toBeGreaterThan(nested)
		// The raw signed sum IS the hole-aware area under this convention, which is what makes the comparison against the
		// publisher's own figure exact rather than approximate.
		expect(resolved.signedAreaM2).toBeCloseTo(nested, 3)
	})

	it("keeps two disjoint exteriors as two polygons rather than cancelling them", () => {
		const resolved = resolveRingRoles(
			[
				[exteriorRing(ORIGIN.lon, ORIGIN.lat, ORIGIN.lon + SIDE, ORIGIN.lat + SIDE)],
				[exteriorRing(ORIGIN.lon + 2 * SIDE, ORIGIN.lat, ORIGIN.lon + 3 * SIDE, ORIGIN.lat + SIDE)],
			],
			"5"
		)

		expect(resolved.exteriorCount).toBe(2)
		expect(resolved.polygons).toHaveLength(2)

		const blob = encodeRings(resolved.polygons)

		expect(pointInEncodedRings(blob, ORIGIN.lon + SIDE * 0.5, ORIGIN.lat + SIDE * 0.5)).toBe(true)
		expect(pointInEncodedRings(blob, ORIGIN.lon + 2.5 * SIDE, ORIGIN.lat + SIDE * 0.5)).toBe(true)
	})

	it("puts an island inside a hole on its own polygon, so a point in it reads INSIDE", () => {
		// Three levels: an exterior, a hole in it, and a smaller exterior inside that hole. The even-odd rule handles this
		// only when the island is its own polygon rather than a third ring of the first.
		const resolved = resolveRingRoles(
			[
				[exteriorRing(ORIGIN.lon, ORIGIN.lat, ORIGIN.lon + SIDE, ORIGIN.lat + SIDE)],
				[holeRing(ORIGIN.lon + SIDE * 0.2, ORIGIN.lat + SIDE * 0.2, ORIGIN.lon + SIDE * 0.8, ORIGIN.lat + SIDE * 0.8)],
				[
					exteriorRing(
						ORIGIN.lon + SIDE * 0.4,
						ORIGIN.lat + SIDE * 0.4,
						ORIGIN.lon + SIDE * 0.6,
						ORIGIN.lat + SIDE * 0.6
					),
				],
			],
			"6"
		)

		expect(resolved.exteriorCount).toBe(2)
		expect(resolved.holeCount).toBe(1)

		const blob = encodeRings(resolved.polygons)

		expect(pointInEncodedRings(blob, ORIGIN.lon + SIDE * 0.5, ORIGIN.lat + SIDE * 0.5)).toBe(true)
		expect(pointInEncodedRings(blob, ORIGIN.lon + SIDE * 0.3, ORIGIN.lat + SIDE * 0.3)).toBe(false)
		expect(pointInEncodedRings(blob, ORIGIN.lon + SIDE * 0.1, ORIGIN.lat + SIDE * 0.1)).toBe(true)
	})

	it("puts a hole under the SMALLEST exterior containing it, so a nested hole lands on the island", () => {
		const resolved = resolveRingRoles(
			[
				[exteriorRing(ORIGIN.lon, ORIGIN.lat, ORIGIN.lon + SIDE, ORIGIN.lat + SIDE)],
				[
					exteriorRing(
						ORIGIN.lon + SIDE * 0.2,
						ORIGIN.lat + SIDE * 0.2,
						ORIGIN.lon + SIDE * 0.8,
						ORIGIN.lat + SIDE * 0.8
					),
				],
				[holeRing(ORIGIN.lon + SIDE * 0.4, ORIGIN.lat + SIDE * 0.4, ORIGIN.lon + SIDE * 0.6, ORIGIN.lat + SIDE * 0.6)],
			],
			"7"
		)

		const smaller = resolved.polygons.find((polygon) => polygon.length === 2)

		expect(smaller).toBeDefined()

		// The hole belongs to the inner exterior. On the outer one it would still answer the same point, but the recorded
		// structure would say the outer polygon has a hole the publisher never put in it.
		expect(Math.abs(ringSignedAreaM2(smaller![0]!))).toBeLessThan(
			Math.abs(ringSignedAreaM2(resolved.polygons.find((polygon) => polygon.length === 1)![0]!))
		)
	})

	it("carries a hole that shares its parent's boundary rather than dropping it, and counts it", () => {
		// The residual case, measured at 9 of 3,516 holes nationally and every one a sliver under 1.7 m²: a ring whose
		// vertices sit ON the exterior. Dropping it would add ground the plan carved out; the count is on the receipt so a
		// reader sees the number rather than assuming it is zero.
		const resolved = resolveRingRoles(
			[
				[exteriorRing(ORIGIN.lon, ORIGIN.lat, ORIGIN.lon + SIDE, ORIGIN.lat + SIDE)],
				[holeRing(ORIGIN.lon - SIDE, ORIGIN.lat - SIDE, ORIGIN.lon - SIDE * 0.5, ORIGIN.lat - SIDE * 0.5)],
			],
			"8"
		)

		expect(resolved.holeCount).toBe(1)
		expect(resolved.nestedHoles).toBe(0)
		expect(resolved.adjacentHoles).toBe(1)
		expect(resolved.polygons[0]).toHaveLength(2)
	})

	it("takes the LARGEST ring as the exterior where no ring reads as one, and counts it", () => {
		// Measured at exactly one feature of 85,330: a three-vertex sliver enclosing 3.0 × 10⁻⁷ m², whose winding is
		// floating-point noise rather than something the publisher stated — it reads clockwise in the source's own metres
		// and counter-clockwise after reprojection. Refusing would fail the build on the publisher's own data; skipping the
		// feature would invent an absence.
		const resolved = resolveRingRoles([[holeRing(ORIGIN.lon, ORIGIN.lat, ORIGIN.lon + SIDE, ORIGIN.lat + SIDE)]], "9")

		expect(resolved.exteriorCount).toBe(1)
		expect(resolved.holeCount).toBe(0)
		expect(resolved.exteriorByMagnitude).toBe(1)

		const blob = encodeRings(resolved.polygons)

		expect(pointInEncodedRings(blob, ORIGIN.lon + SIDE / 2, ORIGIN.lat + SIDE / 2)).toBe(true)
	})

	it("reads a wholly inverted feature correctly, taking its largest ring as the exterior", () => {
		// The same fallback, on the case it also has to be right for: a feature published with every winding flipped. The
		// largest ring is still the one that encloses the area, so the reading comes out the same as the publisher's.
		const resolved = resolveRingRoles(
			[
				[holeRing(ORIGIN.lon, ORIGIN.lat, ORIGIN.lon + SIDE, ORIGIN.lat + SIDE)],
				[holeRing(ORIGIN.lon + SIDE * 0.3, ORIGIN.lat + SIDE * 0.3, ORIGIN.lon + SIDE * 0.7, ORIGIN.lat + SIDE * 0.7)],
			],
			"9b"
		)

		expect(resolved.exteriorCount).toBe(1)
		expect(resolved.holeCount).toBe(1)
		expect(resolved.exteriorByMagnitude).toBe(1)

		const blob = encodeRings(resolved.polygons)

		expect(pointInEncodedRings(blob, ORIGIN.lon + SIDE * 0.5, ORIGIN.lat + SIDE * 0.5)).toBe(false)
		expect(pointInEncodedRings(blob, ORIGIN.lon + SIDE * 0.1, ORIGIN.lat + SIDE * 0.1)).toBe(true)
	})

	it("does NOT reach for the fallback where the orientation reads cleanly", () => {
		const resolved = resolveRingRoles(
			[[exteriorRing(ORIGIN.lon, ORIGIN.lat, ORIGIN.lon + SIDE, ORIGIN.lat + SIDE)]],
			"9c"
		)

		expect(resolved.exteriorByMagnitude).toBe(0)
	})

	it("refuses a feature carrying no ring at all", () => {
		expect(() => resolveRingRoles([], "10")).toThrow(/carries no ring/u)
	})
})
