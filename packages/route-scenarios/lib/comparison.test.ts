/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, test } from "vitest"

import { compareCases, type ComparisonCase, lowerPriceCase } from "#comparison"
import { ScenarioInput } from "#scenario"
import {
	BUILDING_A,
	COMPARISON_CASES,
	SHARED_ROUTE,
	SYNTHETIC,
	syntheticDossier,
	withChange,
} from "#test/fixtures/shared-route"

const dossier = syntheticDossier()
const rows = compareCases(dossier, SHARED_ROUTE, COMPARISON_CASES)
const byID = (id: string) => rows.find((row) => row.id === id)!

describe("one set of buildings and conventions", () => {
	test("the base case leads, with USD 16,000.00 of capex and first revenue in month 4", () => {
		expect(rows.map((row) => row.id)).toEqual([
			"base",
			"no-build",
			"delayed-access",
			"slower-uptake",
			"lower-price",
			"cost-overrun",
			"retrofit-b",
		])

		expect(byID("base")).toMatchObject({
			capex: 1_600_000,
			npv: 267_608,
			firstRevenueMonth: 4,
			cashBeforeFirstRevenue: 1_717_000,
			peakFunding: { amount: 2_028_500, month: 6 },
		})
	})

	test("no build spends and earns nothing over the same 40 occupied units", () => {
		expect(byID("no-build")).toMatchObject({
			capex: 0,
			npv: 0,
			firstRevenueMonth: null,
			cashBeforeFirstRevenue: 0,
			peakFunding: { amount: 0, month: null },
		})

		expect(byID("no-build").table.rows[8]!.occupied).toBe(40)
	})

	test("delaying service by 6 months moves first revenue from month 4 to month 10 and lowers the NPV", () => {
		const delayed = byID("delayed-access")

		expect(delayed.firstRevenueMonth).toBe(10)
		expect(delayed.npv).toBeLessThan(byID("base").npv)
		expect(delayed.assumption).toBe("service in every selected building starts 6 months later than in the base case")
	})

	test("30% over 8 months: A's month-3 target is ⌊30% × 24 × 1/8⌋ = 0, its first credited month is 4, and first revenue is month 5", () => {
		const slower = byID("slower-uptake")

		expect(slower.table.rows[3]!.newActivations).toBe(0)
		expect(slower.table.rows[4]).toMatchObject({ newActivations: 1, receipts: 5500, promotion: 5500 })
		expect(slower.firstRevenueMonth).toBe(5)
		expect(slower.npv).toBeLessThan(byID("base").npv)
	})

	test("a USD 45.00 price from month 12 takes 20 × 10.00 = 200.00 a month off receipts", () => {
		const lower = byID("lower-price")

		expect(lower.table.rows[11]!.receipts).toBe(110_000)
		expect(lower.table.rows[12]!.receipts).toBe(90_000)
		expect(lower.assumption).toBe("from month 12 (2027-10) the monthly price is USD 45.00 instead of USD 55.00")
		expect(lower.npv).toBeLessThan(0)
	})

	test("a 30% overrun on every construction line costs 16,000 × 1.3 = USD 20,800.00", () => {
		expect(byID("cost-overrun")).toMatchObject({ capex: 2_080_000 })
		expect(byID("cost-overrun").npv).toBeLessThan(0)
	})

	test("retrofit timing adds 4 × USD 300.00 of riser work and moves B's first activation to month 11", () => {
		const late = byID("retrofit-b")

		expect(late.capex).toBe(1_720_000)
		expect(late.table.rows[10]!.buildings[1]!.newActivations).toBe(0)
		expect(late.table.rows[11]!.buildings[1]!.newActivations).toBeGreaterThan(0)
		expect(late.table.rows[11]!.buildings[0]!.building).toBe(BUILDING_A)
	})
})

describe("cases that change a convention", () => {
	test("a case discounted at another rate is refused", () => {
		const other: ComparisonCase = {
			id: "other-rate",
			label: "Another discount rate",
			assumption: "12% instead of 10%",
			scenario: withChange(SHARED_ROUTE, (draft) => {
				draft.annualDiscountRateBasisPoints = 1200
			}),
		}

		expect(() => compareCases(dossier, SHARED_ROUTE, [other])).toThrow(
			expect.objectContaining({
				input: ScenarioInput.Convention,
				path: "cases[other-rate].annualDiscountRateBasisPoints",
			})
		)
	})

	test("a case that selects other buildings is refused", () => {
		const other: ComparisonCase = {
			id: "a-only",
			label: "Building A only",
			assumption: "B is dropped",
			scenario: withChange(SHARED_ROUTE, (draft) => {
				draft.selected = [BUILDING_A]
			}),
		}

		expect(() => compareCases(dossier, SHARED_ROUTE, [other])).toThrow(
			expect.objectContaining({ input: ScenarioInput.Convention, path: "cases[a-only].selected" })
		)
	})

	test("a lower-price case must lower the price", () => {
		expect(() => lowerPriceCase(SHARED_ROUTE, { fromMonth: 12, amount: 6000, basis: SYNTHETIC })).toThrow(
			expect.objectContaining({ input: ScenarioInput.Amount })
		)
	})
})
