// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, it } from "vitest"

import { gnisPlaceRecord } from "#tools/pipeline/us/gnis-backfill"

// Cairo, Ohio (GNIS 1038607), inside Plain Township (WOF localadmin 404524271).
const CAIRO = {
	gnisID: 1_038_607,
	name: "Cairo",
	featureClass: "Populated Place",
	fcode: null,
	state: "OH",
	county: "Stark",
	countyGNISID: null,
	unknownCoordinates: false,
	longitude: -81.3576,
	latitude: 40.8384,
}

const PLAIN_TOWNSHIP = { id: 404_524_271, name: "Plain Township", placetype: "localadmin" }

const PLAIN_TOWNSHIP_HIERARCHY = [
	{
		continent_id: 102_191_575,
		country_id: 85_633_793,
		county_id: 102_083_731,
		localadmin_id: 404_524_271,
		region_id: 85_688_485,
	},
]

describe("gnisPlaceRecord", () => {
	const record = gnisPlaceRecord(
		CAIRO,
		9_895_000_001,
		"locality",
		PLAIN_TOWNSHIP,
		PLAIN_TOWNSHIP_HIERARCHY,
		1_800_000_000
	)

	it("copies the parent's hierarchy and adds the new place to it", () => {
		expect(record.properties["wof:hierarchy"]).toEqual([{ ...PLAIN_TOWNSHIP_HIERARCHY[0], locality_id: 9_895_000_001 }])
		expect(record.properties["wof:parent_id"]).toBe(404_524_271)
	})

	it("lists every ancestor in belongsto, without the place itself", () => {
		expect(record.properties["wof:belongsto"]).toEqual([85_633_793, 85_688_485, 102_083_731, 102_191_575, 404_524_271])
	})

	it("carries the GNIS id as a concordance and cites GNIS for the name and the point", () => {
		expect(record.properties["wof:concordances"]).toEqual({ "gnis:id": 1_038_607 })

		const cited = (record.properties["mailwoman:sources"] as Array<{ property: string }>).map(
			({ property }) => property
		)

		expect(cited).toEqual(expect.arrayContaining(["wof:name", "geometry", "wof:placetype", "wof:hierarchy"]))
		expect(record.geometry).toEqual({ type: "Point", coordinates: [-81.3576, 40.8384] })
	})
})
