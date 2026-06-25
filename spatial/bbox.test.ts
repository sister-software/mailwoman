/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { is2DBBox, is3DBBox, isBBox } from "@mailwoman/spatial"
import { expect, test } from "vitest"

// 2D GeoJSON bbox: [west, south, east, north]. 3D adds min/max altitude: [w, s, minA, e, n, maxA].
const BBOX_2D = [-74.1, 40.6, -73.9, 40.9]
const BBOX_3D = [-74.1, 40.6, 0, -73.9, 40.9, 100]

test("is2DBBox: a length-4 tuple is 2D; a length-6 tuple is not", () => {
	// Regression: this guard used to check length === 6 (a copy of is3DBBox), so it never
	// recognized a real 2D bbox.
	expect(is2DBBox(BBOX_2D)).toBe(true)
	expect(is2DBBox(BBOX_3D)).toBe(false)
})

test("is3DBBox: a length-6 tuple is 3D; a length-4 tuple is not", () => {
	expect(is3DBBox(BBOX_3D)).toBe(true)
	expect(is3DBBox(BBOX_2D)).toBe(false)
})

test("isBBox: accepts length 4 or 6, rejects other shapes", () => {
	expect(isBBox(BBOX_2D)).toBe(true)
	expect(isBBox(BBOX_3D)).toBe(true)
	expect(isBBox([1, 2, 3, 4, 5])).toBe(false) // length 5
	expect(isBBox([1, 2, 3])).toBe(false) // length 3
})

test("the bbox guards reject non-array input", () => {
	for (const input of [null, undefined, {}, "bbox", 4, { length: 4 }]) {
		expect(is2DBBox(input)).toBe(false)
		expect(is3DBBox(input)).toBe(false)
		expect(isBBox(input)).toBe(false)
	}
})
