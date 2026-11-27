// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, it } from "vitest"

import { createOutcomeEvidenceTable } from "#outcome/evidence"
import type { CompiledOutcomeSpec, OutcomeDefinition } from "#outcome/spec"

const names = ["place", "place.borough", "place.locality", "natural", "natural.island", "address"]

const spec: CompiledOutcomeSpec = {
	definitions: names.map((name, index) => ({
		"mw:id": index + 1,
		"mw:name": name,
		"mw:parent": name.includes(".") ? name.split(".")[0]! : null,
	})) as OutcomeDefinition[],
	registry: names.map((name, index) => ({ "mw:id": index + 1, "mw:name": name })),
	defaults: { borough: ["place.borough"], locality: ["place.locality"] },
	exemptions: {},
	evidence: {
		geonames: { "P.PPL": ["place.locality"], "T.ISL": ["natural.island"], "A.ADMD": ["place"] },
		osm: { "addr:housenumber=*": ["address"] },
		wikidata: {},
	},
	counter_evidence: { geonames: { "P.PPLQ": ["place.locality"] }, osm: {}, wikidata: {} },
}

const table = createOutcomeEvidenceTable(spec)

describe("createOutcomeEvidenceTable", () => {
	it("writes an assertion beyond the defaults, as Manhattan's island beside its borough", () => {
		expect(table.recordRows("borough", table.assertionsFor("geonames", "T.ISL"))).toEqual([
			{ outcomeID: 5, contested: false },
		])
	})

	it("writes zero rows for evidence the defaults already satisfy, including a parent", () => {
		expect(table.recordRows("locality", table.assertionsFor("geonames", "P.PPL"))).toEqual([])
		expect(table.recordRows("borough", table.assertionsFor("geonames", "A.ADMD"))).toEqual([])
	})

	it("keeps a denied default in the set and marks it contested", () => {
		expect(table.recordRows("locality", table.assertionsFor("geonames", "P.PPLQ"))).toEqual([
			{ outcomeID: 3, contested: true },
		])
	})

	it("writes zero rows for a denial of a member the record doesn't hold", () => {
		expect(table.recordRows("borough", table.assertionsFor("geonames", "P.PPLQ"))).toEqual([])
	})

	it("matches an OSM value against the definitions' any-value form", () => {
		expect(table.assertionsFor("osm", "addr:housenumber=12")).toEqual([
			{ outcome: "address", stance: "asserts", src: "osm:addr:housenumber=12" },
		])
	})

	it("refuses a curated removal, which the compiled tables can't hold", () => {
		expect(() =>
			table.recordRows("locality", [{ outcome: "place.locality", stance: "denies", src: "curated:#1" }])
		).toThrow(/curated/)
	})
})
