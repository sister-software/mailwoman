/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { representativePoint } from "@mailwoman/osm/sdk/representative-point"
import { expect, test } from "vitest"

test("representativePoint preserves a finite point", () => {
	expect(representativePoint({ type: "Point", coordinates: [2.35, 48.86] })).toEqual([2.35, 48.86])
})

test("representativePoint averages distinct exterior-ring vertices", () => {
	expect(
		representativePoint({
			type: "Polygon",
			coordinates: [
				[
					[0, 0],
					[2, 0],
					[2, 2],
					[0, 2],
					[0, 0],
				],
			],
		})
	).toEqual([1, 1])
})

test("representativePoint reads the first polygon of a multipolygon", () => {
	expect(
		representativePoint({
			type: "MultiPolygon",
			coordinates: [
				[
					[
						[1, 1],
						[3, 1],
						[2, 4],
						[1, 1],
					],
				],
			],
		})
	).toEqual([2, 2])
})

test("representativePoint rejects absent, unsupported, and non-finite geometry", () => {
	expect(representativePoint(null)).toBeNull()
	expect(representativePoint({ type: "LineString", coordinates: [] })).toBeNull()
	expect(representativePoint({ type: "Point", coordinates: [Number.NaN, 1] })).toBeNull()
})
