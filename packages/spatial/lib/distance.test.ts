/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { expect, test } from "vitest"

import { planarSegmentDistanceSquared } from "#distance"

test("planarSegmentDistanceSquared measures to the edge between the vertices", () => {
	// 30 m north of the midpoint of a 200 m east-west segment, 100 m from either vertex.
	expect(planarSegmentDistanceSquared(100, 30, 0, 0, 200, 0)).toBe(900)
})

test("planarSegmentDistanceSquared measures to the nearer vertex beyond either end", () => {
	expect(planarSegmentDistanceSquared(-30, 40, 0, 0, 200, 0)).toBe(2500)
	expect(planarSegmentDistanceSquared(230, -40, 0, 0, 200, 0)).toBe(2500)
})

test("planarSegmentDistanceSquared treats a repeated vertex as a point", () => {
	expect(planarSegmentDistanceSquared(3, 4, 0, 0, 0, 0)).toBe(25)
})
