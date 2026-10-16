/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { NearestLinkJoin, PointBucketIndex } from "#gb/os-open/nearest-link"

describe("PointBucketIndex", () => {
	it("answers every point in a cell the box touches", () => {
		const index = new PointBucketIndex(100)

		index.add(0, 50, 50)
		index.add(1, 150, 50)
		index.add(2, 450, 450)

		expect([...index.within(0, 0, 120, 90)].toSorted()).toEqual([0, 1])
		expect([...index.within(400, 400, 401, 401)]).toEqual([2])
	})

	it("refuses a cell size that is not positive", () => {
		expect(() => new PointBucketIndex(0)).toThrow(RangeError)
	})
})

describe("NearestLinkJoin", () => {
	const points = {
		// A point 30 m north of a long segment's middle, one 150 m away from everything, and one between two roads.
		xs: Float64Array.from([500, 500, 1000]),
		ys: Float64Array.from([30, 400, 40]),
	}

	it("joins by the distance to the segment rather than to its vertices", () => {
		const join = new NearestLinkJoin<string>(points, 100)

		// The vertices are 500 m from the first point.
		// The edge is 30 m from it.
		join.offer("Long Road", [0, 0, 1000, 0])

		expect(join.match(0)).toEqual({ link: "Long Road", distance: 30 })
	})

	it("answers null for a point with no line inside the radius", () => {
		const join = new NearestLinkJoin<string>(points, 100)

		join.offer("Long Road", [0, 0, 1000, 0])

		expect(join.match(1)).toBeNull()
	})

	it("keeps the nearer of two lines whatever order they arrive in", () => {
		const forward = new NearestLinkJoin<string>(points, 100)
		const backward = new NearestLinkJoin<string>(points, 100)

		forward.offer("South Street", [900, 0, 1100, 0])
		forward.offer("North Street", [900, 50, 1100, 50])
		backward.offer("North Street", [900, 50, 1100, 50])
		backward.offer("South Street", [900, 0, 1100, 0])

		expect(forward.match(2)?.link).toBe("North Street")
		expect(backward.match(2)?.link).toBe("North Street")
	})

	it("walks every segment of a polyline", () => {
		const join = new NearestLinkJoin<string>(points, 100)

		// The third segment passes 10 m south of the second point.
		join.offer("Bent Lane", [0, 0, 0, 390, 400, 390, 600, 390])

		expect(join.match(1)).toEqual({ link: "Bent Lane", distance: 10 })
	})
})
