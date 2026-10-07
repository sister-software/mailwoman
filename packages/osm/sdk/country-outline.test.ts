/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The gridded containment test agrees with the exact ray cast, inside, outside and along the border.
 */

import { geometryContains, type ParsedGeometry } from "@mailwoman/spatial"
import { describe, expect, it } from "vitest"

import { createOutlineContainment } from "#sdk/country-outline"

// An L-shaped outline with a hole, so a bounding box would misplace points in the notch.
const outline = {
	type: "Polygon",
	coordinates: [
		[
			[0, 0],
			[4, 0],
			[4, 1],
			[1, 1],
			[1, 4],
			[0, 4],
			[0, 0],
		],
		[
			[0.2, 0.2],
			[0.6, 0.2],
			[0.6, 0.6],
			[0.2, 0.6],
			[0.2, 0.2],
		],
	],
} as ParsedGeometry

describe("createOutlineContainment", () => {
	it("matches the exact test on a lattice across the outline, the notch and the hole", () => {
		const inside = createOutlineContainment(outline)

		for (let lon = -0.5; lon <= 4.5; lon += 0.0137) {
			for (let lat = -0.5; lat <= 4.5; lat += 0.0193) {
				expect(inside(lon, lat), `${lon},${lat}`).toBe(geometryContains(outline, lon, lat) === true)
			}
		}
	})

	it("refuses a geometry that is not areal", () => {
		expect(() => createOutlineContainment({ type: "Point", coordinates: [0, 0] } as ParsedGeometry)).toThrow(
			/Polygon or MultiPolygon/u
		)
	})
})
