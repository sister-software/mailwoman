/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { scorePair } from "@mailwoman/match"
import { describe, expect, it } from "vitest"

import { addressPointModel, gradeAddressPairs, unitsAgree } from "#tools/address-pairs/grade"
import { type AddressPair, type AddressPairRecord, AddressPairStratum } from "#tools/address-pairs/sample"

function point(overrides: Partial<AddressPairRecord>): AddressPairRecord {
	return {
		source: "usgov-nad",
		rank: 0,
		sourceRecordID: "x",
		authority: null,
		number: "12",
		unit: null,
		unitIdentifier: null,
		streetRaw: "Main Street",
		postcode: "53202",
		localities: [],
		placement: null,
		lat: 43.04,
		lon: -87.9,
		stack: 1,
		...overrides,
	}
}

function pair(
	id: string,
	stratum: AddressPairStratum,
	lower: Partial<AddressPairRecord>,
	label: AddressPair["adjudication"],
	ruleDrops: boolean
): AddressPair {
	return {
		pairID: id,
		region: "us-wi",
		stratum,
		higher: point({}),
		lower: point({ source: "openaddresses:us/wi/statewide", rank: 1, ...lower }),
		distanceMeters: 0,
		ruleDrops,
		adjudication: label,
		adjudicator: "fixture",
		rationale: null,
	}
}

describe("gradeAddressPairs", () => {
	it("counts each arm's agreement with the labels per stratum and leaves unsure pairs out", () => {
		const pairs = [
			pair("same", AddressPairStratum.Coincident, {}, "same-address", true),
			pair("spelling", AddressPairStratum.UnitSpelling, {}, "same-address", false),
			pair("unit", AddressPairStratum.UnitAgainstNone, { unit: "A", unitIdentifier: "a" }, "different-address", false),
			pair("unsure", AddressPairStratum.Distant, { lat: 43.1 }, "unsure", false),
		]

		const result = gradeAddressPairs(pairs, pairs)
		const rule = result.arms.find((arm) => arm.arm === "rule")!
		const fellegiSunter = result.arms.find((arm) => arm.arm === "fellegi-sunter")!

		expect(result.graded).toBe(3)
		expect(result.unsure).toBe(1)
		expect(rule.overall).toMatchObject({ truePositive: 1, falseNegative: 1, trueNegative: 1, falsePositive: 0 })
		expect(rule.errors.map((error) => error.pairID)).toEqual(["spelling"])
		// The unit is a precondition, so the unit pair is kept whatever its score.
		expect(fellegiSunter.errors.map((error) => error.pairID)).not.toContain("unit")
	})
})

describe("addressPointModel", () => {
	it("reads no distance evidence from a pair whose point a source shares among more than five addresses", () => {
		const model = addressPointModel()
		const near = scorePair(model, point({}), point({ source: "o", stack: 1 }))
		const stacked = scorePair(model, point({}), point({ source: "o", stack: 500, lat: 37.5 }))
		const distance = (score: typeof near) => score.contributions.find((c) => c.name === "distance")

		expect(distance(near)?.level).toBe("same-building")
		expect(distance(stacked)?.weight ?? 0).toBe(0)
		expect(unitsAgree(point({ unit: "#2" }), point({ unit: "UNIT 2" }))).toBe(true)
	})
})
