// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { landmarkPlaceID } from "@mailwoman/core/resolver"
import { stringifyJSON } from "@mailwoman/core/values/json"
import { createOutcomeEvidenceTable } from "@mailwoman/gazetteer/whosonfirst/outcomes/evidence"
import type { CompiledOutcomeSpec, OutcomeDefinition } from "@mailwoman/gazetteer/whosonfirst/outcomes/spec"
import { describe, expect, it } from "vitest"

import { osmPlaceAssertions, osmPlaceQuery, osmPlaceRows } from "./places.ts"

describe("osmPlaceAssertions", () => {
	const names = ["venue", "venue.park", "natural", "natural.island"]

	const spec: CompiledOutcomeSpec = {
		definitions: names.map((name, index) => ({
			"mw:id": index + 1,
			"mw:name": name,
			"mw:parent": name.includes(".") ? name.split(".")[0]! : null,
			"mw:facet": "identity",
		})) as OutcomeDefinition[],
		registry: names.map((name, index) => ({ "mw:id": index + 1, "mw:name": name })),
		defaults: {},
		exemptions: {},
		evidence: {
			geonames: {},
			osm: { "leisure=park": ["venue.park"], "place=island": ["natural.island"] },
			wikidata: {},
		},
		counter_evidence: { geonames: {}, osm: {}, wikidata: {} },
	}

	const table = createOutcomeEvidenceTable(spec)
	const identity = new Set(names)

	const outcomesOf = (key: string, value: string) =>
		osmPlaceAssertions({ osm_type: "W", osm_id: 1, osm_key: key, osm_value: value }, table, identity).map(
			(assertion) => assertion.outcome
		)

	it("asserts the members the evidence maps the place's tag to", () => {
		expect(outcomesOf("leisure", "park")).toEqual(["venue.park"])
		expect(outcomesOf("place", "island")).toEqual(["natural.island"])
	})

	it("asserts venue for a selected class the evidence leaves unmapped", () => {
		expect(outcomesOf("man_made", "lighthouse")).toEqual(["venue"])
	})

	it("refuses a document without its tag", () => {
		expect(() => osmPlaceAssertions({ osm_type: "W", osm_id: 1 }, table, identity)).toThrow(/osm:W1 has no osm_key/)
	})
})

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
