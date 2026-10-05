/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { buildDossier, reportLines, UnitStage } from "@mailwoman/dossier"
import { buildingFeatures, districtFeatures, routeFeatures, selectionEconomics } from "@mailwoman/opportunity-map"
import {
	BUILDING_A,
	BUILDING_B,
	BUILDING_C,
	DISTRICT_RECORDS,
	DISTRICT_SCENARIO,
	GARAGE,
	SEGMENT_PATHS,
} from "@mailwoman/opportunity-map/example-district"
import { renderScenarioReport, scenarioReport, UnresolvedUnitTotalError } from "@mailwoman/route-scenarios"
import { describe, expect, test } from "vitest"

import { controlDefaults, scenarioFor } from "#controls"
import { REPORT_OPTIONS } from "#evidence"
import { EXAMPLE_DISTRICT, opportunityView } from "#view"

const defaults = controlDefaults(DISTRICT_SCENARIO)
const dossier = buildDossier(DISTRICT_RECORDS, { asOf: DISTRICT_SCENARIO.asOf })
const SELECTION = [BUILDING_A, BUILDING_B, BUILDING_C]

describe("opportunityView", () => {
	test("returns what the model returns for the selection, unchanged", () => {
		const view = opportunityView(EXAMPLE_DISTRICT, defaults, new Set(SELECTION))

		expect(view.selection).toEqual(SELECTION)
		expect(view.buildings).toEqual(buildingFeatures(dossier, { unitStage: UnitStage.Completed }))

		expect(view.districts).toEqual(
			districtFeatures(dossier, { unitStage: UnitStage.Completed, extentKind: "example-district" })
		)

		expect(view.routes).toEqual({
			status: "computed",
			value: routeFeatures(dossier, DISTRICT_SCENARIO, SEGMENT_PATHS, SELECTION),
		})

		expect(view.economics).toEqual({
			status: "computed",
			value: selectionEconomics(dossier, DISTRICT_SCENARIO, SELECTION),
		})

		expect(view.costAndValue).toEqual({
			status: "computed",
			value: renderScenarioReport(
				scenarioReport(dossier, { ...DISTRICT_SCENARIO, selected: SELECTION }, REPORT_OPTIONS)
			),
		})

		const lines = reportLines(dossier)

		expect([...view.dossierParts.keys()]).toEqual(dossier.buildings.map((section) => section.building.id))

		for (const [building, part] of view.dossierParts) {
			expect(part).toBe(
				lines
					.filter((entry) => entry.building === building)
					.map((entry) => entry.text)
					.join("\n")
			)
		}
	})

	test("orders the selection as the dossier orders its buildings, whatever the order of selection", () => {
		expect(opportunityView(EXAMPLE_DISTRICT, defaults, new Set([BUILDING_C, BUILDING_A])).selection).toEqual([
			BUILDING_A,
			BUILDING_C,
		])
	})

	test("calls no selection function for an empty selection", () => {
		const view = opportunityView(EXAMPLE_DISTRICT, defaults, new Set())

		expect([view.routes, view.economics, view.costAndValue]).toEqual([
			{ status: "empty" },
			{ status: "empty" },
			{ status: "empty" },
		])
	})

	test("keeps the model's refusal of an unresolved unit total as its name and message", () => {
		const values = { ...defaults, unitStage: UnitStage.Planned }
		const view = opportunityView(EXAMPLE_DISTRICT, values, new Set(SELECTION))

		let thrown: unknown

		try {
			selectionEconomics(dossier, scenarioFor(DISTRICT_SCENARIO, values), SELECTION)
		} catch (error) {
			thrown = error
		}

		expect(thrown).toBeInstanceOf(UnresolvedUnitTotalError)

		expect(view.economics).toEqual({
			status: "refused",
			name: "UnresolvedUnitTotalError",
			message: (thrown as Error).message,
		})

		expect(view.buildings).toEqual(buildingFeatures(dossier, { unitStage: UnitStage.Planned }))
	})

	test("an earlier dossier date changes the evidence, and the model refuses a scenario dated before its rate card", () => {
		const view = opportunityView(EXAMPLE_DISTRICT, { ...defaults, dossierDate: "2026-08-02" }, new Set(SELECTION))
		const early = buildDossier(DISTRICT_RECORDS, { asOf: "2026-08-02" })

		expect(view.buildings).toEqual(buildingFeatures(early, { unitStage: UnitStage.Completed }))
		expect(view.economics).toMatchObject({ status: "refused", name: "ScenarioInputError" })
		expect(view.economics.status === "refused" && view.economics.message).toMatch(/rateCard\.statedOn/)
	})

	test("a building without a plan in the scenario reaches the page as the model's refusal", () => {
		const view = opportunityView(EXAMPLE_DISTRICT, defaults, new Set([GARAGE]))

		expect(view.economics).toMatchObject({ status: "refused", name: "ScenarioInputError" })
		expect(view.routes).toMatchObject({ status: "refused", name: "ScenarioInputError" })
	})
})
