// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { stringifyJSON } from "@mailwoman/core/json"
import { landmarkPlaceID } from "@mailwoman/core/resolver"
import { describe, expect, it } from "vitest"

import { osmPlaceQuery, osmPlaceRows } from "./places.ts"

describe("osmPlaceRows", () => {
	const park = {
		osm_type: "W",
		osm_id: 123,
		name: { default: "Công viên 30/4", en: "April 30th Park", fr: "April 30th Park" },
		coordinate: { lat: 10.7791212, lon: 106.6969563 },
		countrycode: "VN",
		importance: 0.3,
	}

	it("writes a row per distinct name key, displaying the English name", () => {
		const rows = osmPlaceRows(park)

		expect(rows).toHaveLength(2)
		expect(rows[0]).toMatchObject({ qid: "osm:W123", name: "April 30th Park", importance: 0.3, is_primary: 0 })
	})

	it("reads a document with no name or coordinate as no rows", () => {
		expect(osmPlaceRows({ ...park, name: undefined })).toEqual([])
		expect(osmPlaceRows({ ...park, coordinate: undefined })).toEqual([])
	})

	it("gives an OSM row an OpenStreetMap place ID", () => {
		expect(landmarkPlaceID(osmPlaceRows(park)[0]!.qid)).toBe("openstreetmap:W123")
		expect(landmarkPlaceID("Q160409")).toBe("wikidata:Q160409")
	})
})

describe("osmPlaceQuery", () => {
	it("selects each class by its tag key and values", () => {
		expect(stringifyJSON(osmPlaceQuery())).toContain('"osm_value":["islet","island"]')
	})
})
