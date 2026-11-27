// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import type { OutcomeDefinition } from "@mailwoman/core/outcome/spec"
import { describe, expect, it } from "vitest"

import { compileOutcomeSpec, OutcomeCompileError, serializeOutcomeSpec } from "#whosonfirst/outcomes/compile"
import type { OutcomeDefinitionsInput } from "#whosonfirst/outcomes/definition"

function definition(id: number, name: string, init: Partial<OutcomeDefinition> = {}): OutcomeDefinition {
	return {
		"mw:id": id,
		"mw:name": name,
		"mw:parent": name.includes(".") ? name.split(".")[0]! : null,
		"mw:facet": "identity",
		"mw:status": "current",
		"mw:superseded_by": null,
		"mw:concepts": [],
		"name:eng_p": [],
		"mw:default_for": [],
		"mw:evidence": {},
		"mw:counter_evidence": {},
		"wof:concordances": {},
		...init,
	}
}

function input(init: Partial<OutcomeDefinitionsInput> = {}): OutcomeDefinitionsInput {
	return {
		definitions: [
			definition(1, "place", { "mw:evidence": { osm: ["boundary=administrative"] } }),
			definition(2, "place.locality", {
				"mw:default_for": ["locality"],
				"mw:evidence": { geonames: ["P.PPL"] },
				"mw:counter_evidence": { geonames: ["P.PPLQ"] },
			}),
			definition(3, "venue", { "mw:default_for": ["venue"], "mw:evidence": { osm: ["aeroway=aerodrome"] } }),
			definition(4, "transit", { "mw:evidence": { osm: ["aeroway=aerodrome"] } }),
		],
		registry: [
			{ "mw:id": 1, "mw:name": "place" },
			{ "mw:id": 2, "mw:name": "place.locality" },
			{ "mw:id": 3, "mw:name": "venue" },
			{ "mw:id": 4, "mw:name": "transit" },
		],
		exemptions: { timezone: "not an answer" },
		placetypes: ["locality", "timezone", "venue"],
		previousRegistry: null,
		...init,
	}
}

function refusals(init: Partial<OutcomeDefinitionsInput>): readonly string[] {
	try {
		compileOutcomeSpec(input(init))
	} catch (error) {
		if (error instanceof OutcomeCompileError) return error.refusals

		throw error
	}

	return []
}

describe("compileOutcomeSpec", () => {
	it("writes the inverse evidence table, every member a value implies", () => {
		const spec = compileOutcomeSpec(input())

		expect(spec.evidence.osm["aeroway=aerodrome"]).toEqual(["transit", "venue"])
		expect(spec.counter_evidence.geonames["P.PPLQ"]).toEqual(["place.locality"])
		expect(spec.defaults).toEqual({ locality: ["place.locality"], venue: ["venue"] })
	})

	it("is byte-identical across compilations of one input in any file order", () => {
		const reversed = input()
		reversed.definitions.reverse()

		expect(serializeOutcomeSpec(compileOutcomeSpec(reversed))).toBe(serializeOutcomeSpec(compileOutcomeSpec(input())))
	})

	it("refuses a registry gap and a reused number", () => {
		const registry = [
			{ "mw:id": 1, "mw:name": "place" },
			{ "mw:id": 2, "mw:name": "place.locality" },
			{ "mw:id": 2, "mw:name": "venue" },
			{ "mw:id": 5, "mw:name": "transit" },
		]

		const found = refusals({ registry })

		expect(found.some((refusal) => refusal.includes("reuses number 2"))).toBe(true)
		expect(found.some((refusal) => refusal.includes("gap at number 3"))).toBe(true)
	})

	it("refuses a changed row of the previous compilation", () => {
		const found = refusals({ previousRegistry: [{ "mw:id": 3, "mw:name": "venue.park" }] })

		expect(found).toEqual([expect.stringContaining("changed row 3 from venue.park to venue")])
	})

	it("refuses a placetype with neither a default nor an exemption", () => {
		expect(refusals({ placetypes: ["county", "locality", "timezone", "venue"] })).toEqual([
			"county has neither a default nor an exemption.",
		])
	})

	it("refuses OSM place=locality as evidence for place.locality", () => {
		const definitions = input().definitions
		definitions[1]!["mw:evidence"].osm = ["place=locality"]

		expect(refusals({ definitions })).toEqual(["OSM place=locality is never evidence for place.locality."])
	})
})
