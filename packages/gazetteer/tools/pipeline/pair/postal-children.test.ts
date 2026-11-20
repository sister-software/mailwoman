// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, it } from "vitest"

import {
	type ChildLocations,
	nearestPostalPlace,
	partitionPostalChildren,
	postalGridCell,
	type PostalPoints,
} from "#tools/pipeline/pair/postal-children"

/**
 * Postcode points bucketed as `readPostalPoints` buckets them.
 */
function postalGrid(points: Array<{ lat: number; lon: number; place: string }>): Pick<PostalPoints, "grid"> {
	const grid: PostalPoints["grid"] = new Map()

	for (const point of points) {
		const key = postalGridCell(point.lat, point.lon)
		grid.set(key, [...(grid.get(key) ?? []), point])
	}

	return { grid }
}

// The postcode points near Brooklyn's and Park Slope's WOF records, and a namesake Brooklyn in Georgia.
const postal = postalGrid([
	{ lat: 40.6501, lon: -73.9496, place: "brooklyn" },
	{ lat: 40.6681, lon: -73.9806, place: "brooklyn" },
	{ lat: 33.749, lon: -84.388, place: "atlanta" },
	{ lat: 33.71, lon: -84.4, place: "brooklyn" },
])

const locations: ChildLocations = new Map([
	["brooklyn\0new york", [{ id: 421_205_765, lat: 40.652256, lon: -73.956582 }]],
	["park slope\0brooklyn", [{ id: 85_868_117, lat: 40.6715, lon: -73.9814 }]],
	["brooklyn\0atlanta", [{ id: 85_936_429, lat: 33.7501, lon: -84.3881 }]],
])

describe("partitionPostalChildren", () => {
	it("leaves out a child that is the postcode place name at its own WOF location (`brooklyn / new york`)", () => {
		const { kept, dropped } = partitionPostalChildren(
			[
				{ child: "brooklyn", parent: "new york" },
				{ child: "park slope", parent: "brooklyn" },
			],
			postal,
			locations
		)

		expect(dropped).toEqual([{ child: "brooklyn", parent: "new york" }])
		expect(kept).toEqual([{ child: "park slope", parent: "brooklyn" }])
	})

	it("keeps a child whose name is a postcode place elsewhere but not at its own location (`brooklyn / atlanta`)", () => {
		const { dropped } = partitionPostalChildren([{ child: "brooklyn", parent: "atlanta" }], postal, locations)

		expect(dropped).toEqual([])
	})

	it("keeps an entry no WOF record locates, since a name alone isn't the location test", () => {
		const { kept } = partitionPostalChildren([{ child: "brooklyn", parent: "kings" }], postal, locations)

		expect(kept).toEqual([{ child: "brooklyn", parent: "kings" }])
	})
})

describe("nearestPostalPlace", () => {
	it("answers null when no postcode lies within the ring search", () => {
		expect(nearestPostalPlace(postal, -45, 170)).toBeNull()
	})
})
