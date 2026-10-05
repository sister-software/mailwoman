/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, test } from "vitest"

import { projectCashFlow } from "#cash-flow"
import { affordableExtraSpend, breakEvenTakeRate, capexRange, withTakeRate } from "#decision"
import { prepareScenario } from "#eligibility"
import { presentValue } from "#money"
import { CostCategory, ScenarioInput } from "#scenario"
import { CAPEX_RANGE, SHARED_ROUTE, syntheticDossier, withChange } from "#test/fixtures/shared-route"

const dossier = syntheticDossier()
const prepared = prepareScenario(dossier, SHARED_ROUTE)
const table = projectCashFlow(prepared)

describe("affordable extra construction spend", () => {
	test("in month 1 the NPV of USD 2,676.08 allows USD 2,697.42 more spend at the factor 1.00797414", () => {
		// Month 1's flow is −1,100,000.
		// Its present value is −1,100,000 / 1.00797414 = −1,091,297.85, rounded to −1,091,298.
		// An extra X in month 1 keeps NPV at 0 while (1,100,000 + X) / 1.00797414 rounds to at most 1,358,906.
		// X = 269,742 meets that bound and X = 269,743 exceeds it.
		expect(table.npv).toBe(267_608)
		expect(table.rows[1]!.presentValue).toBe(-1_091_298)

		const spend = affordableExtraSpend(table, 1, 0)

		expect(spend).toEqual({
			status: "within_target",
			month: 1,
			calendarMonth: "2026-11",
			discountFactorE8: 100_797_414,
			amount: 269_742,
			npv: 267_608,
			npvAfter: 0,
			target: 0,
		})

		expect(267_608 + 1_091_298 + presentValue(-(1_100_000 + 269_743), 100_797_414)).toBe(-1)
	})

	test("the same spend later in the horizon is discounted further, so more of it fits", () => {
		const late = affordableExtraSpend(table, 24, 0)

		// 267,608 × 1.21 = 323,805.68
		expect(late).toMatchObject({ status: "within_target", discountFactorE8: 121_000_000, amount: 323_806 })
	})

	test("an NPV below the target leaves no affordable spend and reports the shortfall", () => {
		expect(affordableExtraSpend(table, 1, 300_000)).toEqual({
			status: "below_target",
			month: 1,
			calendarMonth: "2026-11",
			npv: 267_608,
			target: 300_000,
			shortfall: 32_392,
		})
	})

	test("a month outside the table is refused", () => {
		expect(() => affordableExtraSpend(table, 49, 0)).toThrow(expect.objectContaining({ input: ScenarioInput.Month }))
	})
})

describe("break-even take rate", () => {
	test("is the lowest take rate whose NPV reaches the target, measured as active over occupied units in month 24", () => {
		const breakEven = breakEvenTakeRate(prepared)

		expect(breakEven.status).toBe("reached")

		if (breakEven.status !== "reached") return

		const at = projectCashFlow(withTakeRate(prepared, breakEven.takeRateBasisPoints))
		const below = projectCashFlow(withTakeRate(prepared, breakEven.takeRateBasisPoints - 1))

		expect(at.npv).toBeGreaterThanOrEqual(0)
		expect(below.npv).toBeLessThan(0)
		expect(breakEven.takeRateBasisPoints).toBeLessThan(5000)

		expect(breakEven).toMatchObject({
			month: 24,
			calendarMonth: "2028-10",
			npv: at.npv,
			active: at.rows[24]!.active,
			occupied: 40,
		})
	})

	test("reports unreachable when even every occupied unit subscribing misses the target", () => {
		const cheap = prepareScenario(
			dossier,
			withChange(SHARED_ROUTE, (draft) => {
				draft.operating.prices = [{ ...draft.operating.prices[0]!, amount: 1500 }]
			})
		)

		const breakEven = breakEvenTakeRate(cheap)

		expect(breakEven.status).toBe("unreachable")
		expect(breakEven).toMatchObject({ month: 24, target: 0 })

		if (breakEven.status === "unreachable") {
			expect(breakEven.npvAtFullTake).toBe(projectCashFlow(withTakeRate(cheap, 10_000)).npv)
			expect(breakEven.npvAtFullTake).toBeLessThan(0)
		}
	})
})

describe("capex range from stated adjustments", () => {
	test("reads low, base and high totals from stated adjustments: 16,000 × 0.9, 16,000, and 10,000 × 1.25 + 6,000", () => {
		const range = capexRange(prepared, CAPEX_RANGE.low, CAPEX_RANGE.high)

		expect([range.low.total, range.base.total, range.high.total]).toEqual([1_440_000, 1_600_000, 1_850_000])
		expect(range.base.label).toBe("rate card as stated")
		expect(range.high.label).toBe("outside plant 25% over the rate card")
	})

	test("refuses a low case that costs more than the base case", () => {
		expect(() =>
			capexRange(
				prepared,
				{ label: "mislabeled", basisPoints: 1000, categories: [CostCategory.OutsidePlant] },
				{ label: "high", basisPoints: 2000, categories: [CostCategory.OutsidePlant] }
			)
		).toThrow(expect.objectContaining({ input: ScenarioInput.Field }))
	})
})
