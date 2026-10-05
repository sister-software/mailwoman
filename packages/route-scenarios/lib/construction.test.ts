/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, test } from "vitest"

import { constructionCost, constructionSchedule, incrementalCost } from "#construction"
import { prepareScenario } from "#eligibility"
import { CostCategory, ScenarioInput } from "#scenario"
import {
	BUILDING_A,
	BUILDING_B,
	CAPEX_RANGE,
	SHARED_ROUTE,
	SYNTHETIC,
	syntheticDossier,
	withChange,
} from "#test/fixtures/shared-route"

const prepared = prepareScenario(syntheticDossier(), SHARED_ROUTE)

describe("the handoff's shared-route example", () => {
	// Shared segment 400 m × USD 25.00 = USD 10,000.00.
	// Mobilization 1 × USD 1,000.00.
	// Branch A 80 m × USD 25.00 = USD 2,000.00.
	// Branch B 120 m × USD 25.00 = USD 3,000.00.

	test("Building A alone costs 10,000 + 1,000 + 2,000 = USD 13,000.00", () => {
		const cost = constructionCost(prepared, [BUILDING_A])

		expect(cost.route).toBe(1_000_000)
		expect(cost.projectTotal).toBe(100_000)
		expect(cost.common).toBe(1_100_000)
		expect(cost.buildings.map((entry) => [entry.building, entry.amount])).toEqual([[BUILDING_A, 200_000]])
		expect(cost.total).toBe(1_300_000)
	})

	test("Building B alone costs 10,000 + 1,000 + 3,000 = USD 14,000.00", () => {
		expect(constructionCost(prepared, [BUILDING_B]).total).toBe(1_400_000)
	})

	test("A and B together charge the shared segment and mobilization once: 10,000 + 1,000 + 2,000 + 3,000 = USD 16,000.00", () => {
		const cost = constructionCost(prepared, [BUILDING_A, BUILDING_B])

		expect(cost.segments.map((entry) => [entry.segment.id, entry.amount, entry.usedBy])).toEqual([
			["shared-route", 1_000_000, [BUILDING_A, BUILDING_B]],
		])

		expect(cost.project.map((entry) => [entry.line.id, entry.amount])).toEqual([["mobilization", 100_000]])
		expect(cost.common).toBe(1_100_000)
		expect(cost.direct).toBe(500_000)
		expect(cost.total).toBe(1_600_000)
	})

	test("adding B to A costs 16,000 − 13,000 = USD 3,000.00, against USD 14,000.00 for B alone", () => {
		const joining = incrementalCost(prepared, [BUILDING_A], BUILDING_B)
		const alone = incrementalCost(prepared, [], BUILDING_B)

		expect(joining).toMatchObject({ before: 1_300_000, after: 1_600_000, incremental: 300_000, newSegments: [] })
		expect(alone).toMatchObject({ before: 0, after: 1_400_000, incremental: 1_400_000, newSegments: ["shared-route"] })
	})

	test("pays the route and mobilization in month 1 and both branches in month 2", () => {
		const schedule = constructionSchedule(constructionCost(prepared))

		expect([...schedule]).toEqual([
			[1, 1_100_000],
			[2, 500_000],
		])
	})
})

describe("segments and project costs", () => {
	const spur = withChange(SHARED_ROUTE, (draft) => {
		draft.segments = [
			...draft.segments,
			{
				id: "b-spur",
				description: "Spur from the shared route toward Example Building B",
				lines: [
					{
						id: "b-spur-trench",
						description: "Underground spur",
						category: CostCategory.OutsidePlant,
						quantity: { value: 60, unit: "m", basis: SYNTHETIC },
						rate: "trench-m",
						month: 1,
					},
				],
			},
		]

		draft.buildings[1]!.route = ["shared-route", "b-spur"]
	})

	const withSpur = prepareScenario(syntheticDossier(), spur)

	test("a segment only B needs is charged when B is selected and never for A alone", () => {
		expect(constructionCost(withSpur, [BUILDING_A]).segments.map((entry) => entry.segment.id)).toEqual(["shared-route"])

		expect(constructionCost(withSpur, [BUILDING_A, BUILDING_B]).segments.map((entry) => entry.segment.id)).toEqual([
			"shared-route",
			"b-spur",
		])

		// 60 m × USD 25.00 = USD 1,500.00 joins B's increment: 3,000 + 1,500 = 4,500.
		expect(incrementalCost(withSpur, [BUILDING_A], BUILDING_B)).toMatchObject({
			incremental: 450_000,
			newSegments: ["b-spur"],
		})
	})

	test("an empty selection pays no route, mobilization or works", () => {
		const cost = constructionCost(prepared, [])

		expect(cost).toMatchObject({ segments: [], project: [], buildings: [], total: 0 })
	})
})

describe("selection errors", () => {
	test("a building without a plan is refused", () => {
		expect(() => constructionCost(prepared, [BUILDING_A, "building:example-z"])).toThrow(
			expect.objectContaining({ input: ScenarioInput.Building, path: "selection[1]" })
		)
	})

	test("adding a building already in the set is refused", () => {
		expect(() => incrementalCost(prepared, [BUILDING_A], BUILDING_A)).toThrow(
			expect.objectContaining({ input: ScenarioInput.Building })
		)
	})
})

describe("cost adjustments", () => {
	test("a 25 percent outside-plant overrun scales the route only: 12,500 + 1,000 + 5,000 = USD 18,500.00", () => {
		const cost = constructionCost(prepared, undefined, CAPEX_RANGE.high)

		expect(cost.route).toBe(1_250_000)
		expect(cost.total).toBe(1_850_000)
	})

	test("a 10 percent reduction on every construction category gives 16,000 × 0.9 = USD 14,400.00", () => {
		expect(constructionCost(prepared, undefined, CAPEX_RANGE.low).total).toBe(1_440_000)
	})

	test("rounds each adjusted line half away from zero: 333 × 1.5 = 499.5 becomes 500", () => {
		const odd = withChange(SHARED_ROUTE, (draft) => {
			draft.rateCard.rates = draft.rateCard.rates.map((rate) =>
				rate.id === "mobilization" ? { ...rate, amount: 333 } : rate
			)
		})

		const cost = constructionCost(prepareScenario(syntheticDossier(), odd), undefined, {
			label: "mobilization 50% over the rate card",
			basisPoints: 5000,
			categories: [CostCategory.Mobilization],
		})

		expect(cost.project.map((entry) => entry.amount)).toEqual([500])
	})
})
