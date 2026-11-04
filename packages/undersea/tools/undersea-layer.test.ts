// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, test } from "vitest"

import type { UnderseaSourceFeature } from "#sdk/download"
import { reduceUnderseaRecord } from "#tools/undersea-layer"

const source = (
	geometry: UnderseaSourceFeature["geometry"],
	name: string | null = "Mariana"
): UnderseaSourceFeature => ({
	type: "Feature",
	geometry,
	properties: { NAME: name, TYPE: "Trench", FEATURE_ID: 7, OBJECTID: 1 },
})

describe("reduceUnderseaRecord", () => {
	test("keeps the longest part of a multi-part line and labels it at its middle vertex", () => {
		const reduced = reduceUnderseaRecord(
			source({
				type: "MultiLineString",
				coordinates: [
					[
						[0, 0],
						[1, 0],
					],
					[
						[10, 10],
						[11, 11],
						[12, 12],
					],
				],
			}),
			"line"
		)

		expect(reduced?.displayName).toBe("Mariana Trench")

		expect(reduced?.assetGeometry).toEqual({
			type: "LineString",
			coordinates: [
				[10, 10],
				[11, 11],
				[12, 12],
			],
		})

		expect(reduced?.labelPoint).toEqual([11, 11])
		expect(reduced?.bbox).toEqual([0, 0, 12, 12])
	})

	test("labels a concave polygon at a point inside it", () => {
		// A U shape whose bounding-box center, (2, 2), lies in the notch outside the polygon.
		const ring: Array<[number, number]> = [
			[0, 0],
			[4, 0],
			[4, 4],
			[3, 4],
			[3, 1],
			[1, 1],
			[1, 4],
			[0, 4],
			[0, 0],
		]

		const reduced = reduceUnderseaRecord(source({ type: "Polygon", coordinates: [ring] }), "polygon")
		const [lon, lat] = reduced!.labelPoint

		expect(lat).toBe(2)
		expect(lon === 0.5 || lon === 3.5).toBe(true)
		expect(reduced?.assetGeometry.type).toBe("Point")
	})

	test("refuses a record without a name or geometry", () => {
		expect(reduceUnderseaRecord(source({ type: "Point", coordinates: [1, 2] }, null), "point")).toBeNull()
		expect(reduceUnderseaRecord(source(null), "point")).toBeNull()
	})
})
