// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, it } from "vitest"

import type { GroupingDefinitions } from "#sdk/sources"
import { normalizeGroupings, readIMFAdvanced, statedDate } from "#tools/groupings"
import type { SPARQLResults } from "#tools/normalize"
import type { CountryRecord } from "#types"

const ENTITY = "http://www.wikidata.org/entity/"

const country = (alpha2: string, entity: string, name: string): CountryRecord => ({
	entityID: `wikidata:${entity}`,
	alpha2,
	alpha3: `${alpha2}X`,
	numeric: "001",
	name,
	status: "officially-assigned",
})

const COUNTRIES = [country("AA", "Q1", "Alpha"), country("BB", "Q2", "Beta"), country("CC", "Q3", "Gamma")]

interface Row {
	org: string
	member: string
	statement: string
	rank?: string
	role?: string
	start?: [string, string]
	end?: [string, string]
}

function results(rows: Row[]): SPARQLResults {
	return {
		results: {
			bindings: rows.map((row) => ({
				org: { type: "uri", value: `${ENTITY}${row.org}` },
				member: { type: "uri", value: `${ENTITY}${row.member}` },
				statement: { type: "uri", value: `${ENTITY}statement/${row.statement}` },
				rank: { type: "uri", value: `http://wikiba.se/ontology#${row.rank ?? "NormalRank"}` },
				...(row.role ? { role: { type: "uri", value: `${ENTITY}${row.role}` } } : {}),
				...(row.start
					? {
							start: { type: "literal", value: row.start[0] },
							startPrecision: { type: "literal", value: row.start[1] },
						}
					: {}),
				...(row.end
					? { end: { type: "literal", value: row.end[0] }, endPrecision: { type: "literal", value: row.end[1] } }
					: {}),
			})),
		},
	}
}

function definitions(
	groupings: GroupingDefinitions["groupings"],
	extra: Partial<GroupingDefinitions> = {}
): GroupingDefinitions {
	return { schemaVersion: 1, groupings, entities: {}, roles: { Q900: "member", Q901: "associate" }, ...extra }
}

function run(p463: Row[], p527: Row[], defs: GroupingDefinitions, wikitext = "") {
	return normalizeGroupings({
		definitions: defs,
		countries: COUNTRIES,
		p463: results(p463),
		p527: results(p527),
		worldbank: [{}, []],
		worldbankAsOf: null,
		wikitext,
		wikitextAsOf: null,
		profile: "test",
	})
}

const ORG: GroupingDefinitions["groupings"][number] = {
	id: "org",
	name: "Org",
	kind: "organization",
	source: { type: "wikidata", item: "Q100", property: "P463" },
}

describe("statedDate", () => {
	it("keeps a day, pads a month, and reads every coarser precision as its year", () => {
		expect(statedDate("+2020-01-31T00:00:00Z", "11")).toEqual({ date: "2020-01-31", precision: "day" })
		expect(statedDate("+1995-06-00T00:00:00Z", "10")).toEqual({ date: "1995-06-01", precision: "month" })
		expect(statedDate("+1990-00-00T00:00:00Z", "8")).toEqual({ date: "1990-01-01", precision: "year" })
		expect(statedDate(undefined, undefined)).toBeNull()
	})
})

describe("normalizeGroupings", () => {
	it("reads roles, drops deprecated statements and reports members with no ISO record", () => {
		const { normalized, reports } = run(
			[
				{ org: "Q100", member: "Q1", statement: "s1", start: ["+1990-01-01T00:00:00Z", "11"] },
				{ org: "Q100", member: "Q2", statement: "s2", role: "Q901" },
				{ org: "Q100", member: "Q3", statement: "s3", rank: "DeprecatedRank" },
				{ org: "Q100", member: "Q999", statement: "s4" },
			],
			[],
			definitions([ORG])
		)

		expect(normalized.groupings[0]!.blockedBy).toEqual([])

		expect(normalized.records.map((row) => [row.code, row.role])).toEqual([
			["AA", "member"],
			["BB", "associate"],
		])

		expect(reports["org"]!.uncoded).toEqual(["Q999"])
		expect(reports["org"]!.withoutStart).toBe(1)
	})

	it("blocks a grouping whose statement holds a role outside the role table, and keeps none of its rows", () => {
		const { normalized } = run(
			[
				{ org: "Q100", member: "Q1", statement: "s1" },
				{ org: "Q100", member: "Q2", statement: "s2", role: "Q777" },
			],
			[],
			definitions([ORG])
		)

		expect(normalized.groupings[0]!.blockedBy).toEqual(["statement s2 has role Q777, which the role table omits"])
		expect(normalized.records).toEqual([])
	})

	it("blocks a grouping whose source states no member rather than reading it as empty", () => {
		const { normalized } = run([], [], definitions([ORG]))

		expect(normalized.groupings[0]!.blockedBy).toEqual(["wikidata:Q100 P463 states no member"])
	})

	it("maps an entity alias to its ISO entry and cross-checks the other property", () => {
		const { normalized, reports } = run(
			[
				{ org: "Q100", member: "Q55", statement: "s1" },
				{ org: "Q100", member: "Q2", statement: "s2" },
			],
			[{ org: "Q100", member: "Q3", statement: "s3" }],
			definitions([ORG], { entities: { Q55: "AA" } })
		)

		expect(normalized.records.map((row) => row.code)).toEqual(["AA", "BB"])

		expect(reports["org"]!.crossCheck).toEqual({
			property: "P527",
			otherStates: 1,
			onlySelected: ["AA", "BB"],
			onlyOther: ["CC"],
		})
	})

	it("reads both properties for a grouping declared with both", () => {
		const both = { ...ORG, source: { type: "wikidata" as const, item: "Q100", property: "both" as const } }

		const { normalized, reports } = run(
			[{ org: "Q100", member: "Q1", statement: "s1" }],
			[{ org: "Q100", member: "Q2", statement: "s2" }],
			definitions([both])
		)

		expect(normalized.records.map((row) => row.code)).toEqual(["AA", "BB"])
		expect(reports["org"]!.crossCheck).toBeNull()
	})
})

describe("readIMFAdvanced", () => {
	const ARTICLE = [
		"==Other==",
		"* {{flag country|Nowhere}}",
		"==IMF advanced economies===",
		"According to the [[International Monetary Fund]], 3 countries and territories are officially listed as advanced.",
		"{{columns-list|",
		"* {{flag country|Alpha}}",
		"* {{flag country|Old name|name=Beta}}",
		"Plus<sup>d</sup>",
		"* ''{{flag country|Added by CIA}}''",
		"}}",
		"{{columns-list|",
		"* ''{{flag country|Footnoted}}''<sup>d</sup>",
		"* {{flag country|Gamma}}",
		"}}",
		"===A later subsection===",
		"* {{flag country|Later}}",
	].join("\n")

	it("reads the IMF entries only, preferring the name parameter, and stops at the next heading", () => {
		expect(readIMFAdvanced(ARTICLE)).toEqual({ names: ["Alpha", "Beta", "Gamma"], stated: 3 })
	})

	it("blocks the grouping when the listed entries differ from the section's stated count", () => {
		const imf: GroupingDefinitions["groupings"][number] = {
			id: "imf",
			name: "IMF",
			kind: "classification",
			source: { type: "wikipedia-imf-advanced", aliases: {} },
		}

		const { normalized } = run([], [], definitions([imf]), ARTICLE.replace("3 countries", "4 countries"))

		expect(normalized.groupings[0]!.blockedBy).toEqual(["the section states 4 economies and lists 3"])
	})
})
