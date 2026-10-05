/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { type EntityID, UnitStage } from "@mailwoman/dossier"
import { prepareScenario, projectCashFlow, UnresolvedUnitTotalError } from "@mailwoman/route-scenarios"
import { describe, expect, test } from "vitest"

import {
	BUILDING_A,
	BUILDING_B,
	BUILDING_C,
	BUILDING_E,
	DISTRICT_SCENARIO,
	districtDossier,
	SYNTHETIC,
} from "#example-district"
import { MapInputError } from "#inputs"
import { OverlappingProjectsError, portfolioTotals, selectionEconomics } from "#selection"

const dossier = districtDossier()

/**
 * The cash-flow table that `@mailwoman/route-scenarios` computes for `selection` when called directly.
 */
function direct(selection: readonly EntityID[]) {
	return projectCashFlow(prepareScenario(dossier, { ...DISTRICT_SCENARIO, selected: selection }))
}

function overlapsOf(run: () => unknown) {
	try {
		run()
	} catch (error) {
		if (error instanceof OverlappingProjectsError) return error.overlaps

		throw error
	}

	throw new Error("portfolioTotals accepted overlapping projects")
}

describe("selectionEconomics", () => {
	test("recalculates cost and value through @mailwoman/route-scenarios for each selection", () => {
		for (const selection of [[BUILDING_A], [BUILDING_A, BUILDING_B], [BUILDING_A, BUILDING_B, BUILDING_C]]) {
			const economics = selectionEconomics(dossier, DISTRICT_SCENARIO, selection)
			const table = direct(selection)

			expect(economics.selection).toEqual(selection)
			expect(economics.construction.total).toBe(table.construction.total)
			expect(economics.construction.common).toBe(table.construction.common)
			expect(economics.construction.direct).toBe(table.construction.direct)
			expect(economics.npv).toBe(table.npv)
			expect(economics.firstRevenueMonth).toBe(table.firstRevenueMonth)
			expect(economics.cashBeforeFirstRevenue).toBe(table.cashBeforeFirstRevenue)
			expect(economics.peakFunding).toEqual(table.peakFunding)
		}
	})

	test("charges the shared trench once, so the pair costs less than the two buildings alone", () => {
		const [alone, other, pair] = [[BUILDING_A], [BUILDING_B], [BUILDING_A, BUILDING_B]].map((selection) =>
			selectionEconomics(dossier, DISTRICT_SCENARIO, selection)
		)

		expect([alone!.construction.total, other!.construction.total, pair!.construction.total]).toEqual([
			1_300_000, 1_400_000, 1_600_000,
		])

		expect(pair!.construction.total).toBeLessThan(alone!.construction.total + other!.construction.total)
		expect(pair!.segments).toEqual([{ segment: "shared-trench", usedBy: [BUILDING_A, BUILDING_B], amount: 1_000_000 }])
	})

	test("adding a building changes the selection's units, cost and value", () => {
		const results = [[BUILDING_A], [BUILDING_A, BUILDING_B], [BUILDING_A, BUILDING_B, BUILDING_C]].map((selection) =>
			selectionEconomics(dossier, DISTRICT_SCENARIO, selection)
		)

		expect(results.map((entry) => entry.units)).toEqual([24, 40, 70])
		expect(results.map((entry) => entry.construction.total)).toEqual([1_300_000, 1_600_000, 1_800_000])
		expect(new Set(results.map((entry) => entry.npv)).size).toBe(3)
	})

	test("labels the economics synthetic and keeps each building's units from its dossier total", () => {
		const economics = selectionEconomics(dossier, DISTRICT_SCENARIO, [BUILDING_C])

		expect(economics).toMatchObject({
			scenario: DISTRICT_SCENARIO.id,
			origin: "synthetic",
			synthetic: true,
			currency: "USD",
		})

		expect(economics.eligible).toEqual([
			{
				building: BUILDING_C,
				label: "Example Building C",
				stage: UnitStage.Completed,
				at: "2026-08-01",
				units: 30,
				sources: ["synthetic-inspection-2026"],
				memberships: [`${BUILDING_C}:all`],
			},
		])
	})

	test("refuses a building whose unit total is unresolved and computes no economics for it", () => {
		const scenario = {
			...DISTRICT_SCENARIO,
			buildings: [
				...DISTRICT_SCENARIO.buildings,
				{
					...DISTRICT_SCENARIO.buildings[0]!,
					building: BUILDING_E,
					works: [],
					occupancy: [{ fromMonth: 0, units: 0, basis: SYNTHETIC }],
				},
			],
		}

		expect(() => selectionEconomics(dossier, scenario, [BUILDING_A, BUILDING_E])).toThrow(UnresolvedUnitTotalError)
	})
})

describe("portfolioTotals", () => {
	test("sums projects that share no building and no segment", () => {
		const totals = portfolioTotals(dossier, DISTRICT_SCENARIO, [
			{ id: "trench", buildings: [BUILDING_A, BUILDING_B] },
			{ id: "duct", buildings: [BUILDING_C] },
		])

		expect(totals.projects.map((entry) => [entry.project, entry.construction.total])).toEqual([
			["trench", 1_600_000],
			["duct", 300_000],
		])

		expect(totals.construction).toBe(1_900_000)
		expect(totals.npv).toBe(direct([BUILDING_A, BUILDING_B]).npv + direct([BUILDING_C]).npv)
		expect(totals.units).toBe(70)
		expect(totals).toMatchObject({ currency: "USD", synthetic: true })
	})

	test("refuses two projects that share a segment, naming the pair and the segment", () => {
		const overlaps = overlapsOf(() =>
			portfolioTotals(dossier, DISTRICT_SCENARIO, [
				{ id: "a", buildings: [BUILDING_A] },
				{ id: "b", buildings: [BUILDING_B] },
				{ id: "duct", buildings: [BUILDING_C] },
			])
		)

		expect(overlaps).toEqual([{ projects: ["a", "b"], buildings: [], segments: ["shared-trench"] }])
	})

	test("refuses two projects that share a building", () => {
		expect(() =>
			portfolioTotals(dossier, DISTRICT_SCENARIO, [
				{ id: "all", buildings: [BUILDING_A, BUILDING_B, BUILDING_C] },
				{ id: "duct", buildings: [BUILDING_C] },
			])
		).toThrow(
			"projects all and duct share building:example-c and segment existing-duct. A portfolio total counts only projects that share no building and no segment"
		)
	})

	test("refuses a portfolio without a project and a project identifier used twice", () => {
		expect(() => portfolioTotals(dossier, DISTRICT_SCENARIO, [])).toThrow(MapInputError)

		expect(() =>
			portfolioTotals(dossier, DISTRICT_SCENARIO, [
				{ id: "a", buildings: [BUILDING_A] },
				{ id: "a", buildings: [BUILDING_C] },
			])
		).toThrow(/projects\[1\]\.id: the project identifier a appears twice/)
	})
})
