/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, test } from "vitest"

import { readPointLiteral, recordsFromFieldRows } from "#tools/fetch/wikidata/vital-places/query-entities"

const item = (qid: string) => ({ value: `http://www.wikidata.org/entity/${qid}` })

describe("readPointLiteral", () => {
	test("reads a WKT point as a LatLon, longitude first in the literal", () => {
		expect(readPointLiteral("Point(2.2945 48.858222222)")).toEqual({ lat: 48.858222222, lon: 2.2945 })
	})

	test("refuses a point on another globe", () => {
		expect(readPointLiteral("<http://www.wikidata.org/entity/Q405> Point(-23.4 0.67)")).toBeNull()
	})
})

describe("recordsFromFieldRows", () => {
	test("keeps item classes and countries, drops blank nodes and records an id with no rows as missing", () => {
		const records = recordsFromFieldRows(
			[
				{ qid: "Q243", qrank: 2 },
				{ qid: "Q9", qrank: 1 },
			],
			[
				{ item: item("Q243"), field: { value: "class" }, value: item("Q1440300") },
				{ item: item("Q243"), field: { value: "country" }, value: item("Q142") },
				{
					item: item("Q243"),
					field: { value: "country" },
					value: { value: "http://www.wikidata.org/.well-known/genid/fa9d7281768cb6107898500f83ac44de" },
				},
				{ item: item("Q243"), field: { value: "coordinate" }, value: { value: "Point(2.2945 48.858222222)" } },
				{ item: item("Q243"), field: { value: "label" }, value: { value: "Eiffel Tower" }, language: { value: "en" } },
				{ item: item("Q243"), field: { value: "sitelinks" }, value: { value: "180" } },
			]
		)

		expect(records).toEqual([
			{
				qid: "Q243",
				qrank: 2,
				classes: ["Q1440300"],
				countries: ["Q142"],
				coordinate: { lat: 48.858222222, lon: 2.2945 },
				population: null,
				sitelinks: 180,
				labels: { en: "Eiffel Tower" },
				aliases: {},
			},
			{ qid: "Q9", qrank: 1, missing: true },
		])
	})
})
