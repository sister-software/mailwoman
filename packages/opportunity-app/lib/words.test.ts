/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { buildDossier, UnitStage } from "@mailwoman/dossier"
import {
	BuildingState,
	districtFeatures,
	routeFeatures,
	SegmentStatus,
	selectionEconomics,
} from "@mailwoman/opportunity-map"
import {
	BUILDING_A,
	BUILDING_B,
	BUILDING_C,
	DISTRICT_RECORDS,
	DISTRICT_SCENARIO,
	SEGMENT_PATHS,
} from "@mailwoman/opportunity-map/example-district"
import { describe, expect, test } from "vitest"

import {
	districtHeading,
	inputBasisText,
	monthText,
	positionText,
	recalculationText,
	SEGMENT_WORDS,
	segmentText,
	STATE_WORDS,
	statesText,
	unitsText,
} from "#words"

const dossier = buildDossier(DISTRICT_RECORDS, { asOf: DISTRICT_SCENARIO.asOf })
const labels = new Map(dossier.buildings.map((section) => [section.building.id, section.building.label]))

describe("STATE_WORDS and SEGMENT_WORDS", () => {
	test("give each state its wire value in words, and both unknown states the word unknown", () => {
		for (const state of Object.values(BuildingState)) {
			expect(STATE_WORDS[state]).toBe(state.replaceAll("_", " "))
		}

		expect(STATE_WORDS[BuildingState.UnknownCoverage]).toMatch(/\bunknown\b/)
		expect(STATE_WORDS[BuildingState.UnknownUnitCount]).toMatch(/\bunknown\b/)
	})

	test("name a verified segment as existing and a proposed one as construction", () => {
		expect(SEGMENT_WORDS[SegmentStatus.Verified]).toBe("verified existing segment")
		expect(SEGMENT_WORDS[SegmentStatus.Proposed]).toBe("proposed construction")
	})
})

describe("unitsText", () => {
	test("writes a resolved total with its stage and date, and an unresolved one as the word unresolved", () => {
		expect(unitsText({ stage: UnitStage.Completed, at: "2026-08-01", total: 24, sources: [] })).toBe(
			"Units: 24 completed units on 2026-08-01"
		)

		expect(unitsText({ stage: UnitStage.Completed, at: "2026-09-30", total: 0, sources: [] })).toBe(
			"Units: 0 completed units on 2026-09-30"
		)

		const unresolved = unitsText({
			stage: UnitStage.Planned,
			at: "2026-09-30",
			total: "unresolved",
			reason: "no planned count",
			sources: [],
		})

		expect(unresolved).toBe("Units: unresolved at the planned stage")
		expect(unresolved).not.toMatch(/\d/)
	})
})

describe("monthText and inputBasisText", () => {
	test("write a month with its calendar month, or no month within the horizon", () => {
		expect(monthText("2026-10-01", 4)).toBe("month 4 (2027-02)")
		expect(monthText("2027-01-01", 6)).toBe("month 6 (2027-07)")
		expect(monthText("2026-10-01", null)).toBe("none within the horizon")
	})

	test("write a source record and an operator assumption apart", () => {
		expect(inputBasisText({ kind: "source_record", source: "synthetic-plant-record-2026" })).toBe(
			"source record synthetic-plant-record-2026"
		)

		expect(inputBasisText({ kind: "operator_assumption", statedBy: "the scenario controls" })).toBe(
			"operator assumption stated by the scenario controls"
		)
	})
})

describe("positionText", () => {
	test("labels a synthetic position synthetic and lists the positions an unresolved one holds", () => {
		expect(positionText({ status: "resolved", synthetic: true, sources: ["synthetic-survey-2026"] })).toBe(
			"Position: synthetic, from synthetic-survey-2026."
		)

		expect(
			positionText({
				status: "unresolved",
				reason: "2 positions state 2 different locations",
				candidates: [
					{ latitude: -30.012, longitude: -20.011, synthetic: true, source: "synthetic-survey-2026" },
					{ latitude: -30.0121, longitude: -20.0113, synthetic: true, source: "synthetic-inspection-2026" },
				],
			})
		).toBe(
			"Position: unresolved, 2 positions state 2 different locations: -30.012, -20.011 per synthetic-survey-2026, synthetic; " +
				"-30.0121, -20.0113 per synthetic-inspection-2026, synthetic. The map draws no marker for this building."
		)
	})
})

describe("districtHeading and statesText", () => {
	test("name each district and count its buildings in each state in the order of the state rules", () => {
		const districts = districtFeatures(dossier, { unitStage: UnitStage.Completed, extentKind: "example-district" })

		expect(
			districts.features.map(({ properties }) => [districtHeading(properties), statesText(properties.states)])
		).toEqual([
			["example-district:north", "1 unknown unit count, 1 partial availability and 1 known unserved"],
			["example-district:south", "1 zero premises and 1 unknown coverage"],
			["Buildings with no example-district membership", "1 unknown coverage"],
			["Buildings with two or more example-district memberships", "1 unknown coverage"],
		])
	})
})

describe("segmentText", () => {
	test("states each segment's status, sharing, basis, path and cost in words", () => {
		const routes = routeFeatures(dossier, DISTRICT_SCENARIO, SEGMENT_PATHS, [BUILDING_A, BUILDING_B, BUILDING_C])

		expect(routes.features.map(({ properties }) => segmentText(properties, labels))).toEqual([
			"shared-trench: proposed construction, shared. Proposed trench from the splice point to Example Buildings A and B. " +
				"Used by Example Building A and Example Building B. " +
				"Basis: operator assumption stated by synthetic example for #2289. Path: synthetic. " +
				"Construction cost in this selection: USD 10,000.00, synthetic.",
			"existing-duct: verified existing segment. Cable through the existing duct on Example Street to Example Building C. " +
				"Used by Example Building C. Basis: source record synthetic-plant-record-2026. Path: synthetic. " +
				"Construction cost in this selection: USD 1,000.00, synthetic.",
		])
	})
})

describe("recalculationText", () => {
	test("announces the empty selection, a refusal and the two headline figures", () => {
		expect(recalculationText({ status: "empty" })).toBe("No building is selected.")

		expect(
			recalculationText({ status: "refused", name: "UnresolvedUnitTotalError", message: "the total is unresolved" })
		).toBe("Recalculated: no figures. the total is unresolved")

		expect(
			recalculationText({ status: "computed", value: selectionEconomics(dossier, DISTRICT_SCENARIO, [BUILDING_A]) })
		).toBe(
			"Recalculated for 1 selected building: total construction cost USD 13,000.00, " +
				"net present value USD -1,946.03, synthetic figures."
		)
	})
})
