/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The synthetic scenario's monthly rows, checked by hand. Amounts are in cents.
 *
 *   Example Building A has 24 occupied units from month 0. Example Building B has 0, then 8 from month 4 and 16
 *   from month 8.
 *   Both take customers from month 3. The take rate is 50% reached over four months, so a building's target
 *   in its k-th service month is ⌊50% × occupied × min(k, 4) / 4⌋. Monthly churn is 2%, applied in whole
 *   subscribers as the floor of the cumulative expected churn, and a churned subscriber is replaced in the
 *   same month. Each new subscriber costs USD 250.00 to activate and USD 50.00 to acquire, and the whole
 *   first month's price, USD 55.00, is credited. Service costs USD 10.00 per subscriber and maintenance
 *   USD 40.00 per month from month 3. The price is USD 55.00.
 */

import { describe, expect, test } from "vitest"

import { calendarMonth, noBuildCashFlow, projectCashFlow } from "#cash-flow"
import { prepareScenario } from "#eligibility"
import { ScenarioInput, TaxTreatmentKind } from "#scenario"
import {
	BUILDING_A,
	BUILDING_B,
	SHARED_ROUTE,
	SYNTHETIC,
	syntheticDossier,
	withChange,
} from "#test/fixtures/shared-route"

const dossier = syntheticDossier()
const table = projectCashFlow(prepareScenario(dossier, SHARED_ROUTE))
const row = (month: number) => table.rows[month]!

describe("calendar months", () => {
	test("counts months from the month of the month-zero date", () => {
		expect(calendarMonth("2026-10-01", 0)).toBe("2026-10")
		expect(calendarMonth("2026-10-15", 3)).toBe("2027-01")
		expect(calendarMonth("2026-10-01", 48)).toBe("2030-10")
	})

	test("runs from month 0 through the horizon", () => {
		expect(table.rows).toHaveLength(49)
		expect(row(48).calendarMonth).toBe("2030-10")
	})
})

describe("occupied units and active subscribers stay separate", () => {
	test("month 0 to 2: 24 occupied units, no subscribers before service starts", () => {
		for (const month of [0, 1, 2]) {
			expect(row(month)).toMatchObject({ occupied: 24, active: 0, newActivations: 0, receipts: 0 })
		}
	})

	test("month 3: A's first target is ⌊50% × 24 × 1/4⌋ = 3 and B has no occupied unit yet", () => {
		expect(row(3).buildings).toEqual([
			{ building: BUILDING_A, occupied: 24, active: 3, newActivations: 3, churn: 0, joined: 0 },
			{ building: BUILDING_B, occupied: 0, active: 0, newActivations: 0, churn: 0, joined: 0 },
		])
	})

	test("month 4: A reaches ⌊50% × 24 × 2/4⌋ = 6 and B, at 8 occupied units, ⌊50% × 8 × 2/4⌋ = 2", () => {
		expect(row(4)).toMatchObject({ occupied: 32, active: 8, newActivations: 5 })
	})

	test("month 8: B's occupancy doubles to 16 and its target to ⌊50% × 16⌋ = 8, so the project holds 20 of 40", () => {
		expect(row(8)).toMatchObject({ occupied: 40, active: 20, newActivations: 4 })
	})
})

describe("hand-checked monthly rows", () => {
	test("month 1: the route and mobilization, 1,000,000 + 100,000, are the only flow", () => {
		expect(row(1)).toMatchObject({
			constructionAndReplacement: 1_100_000,
			cashFlow: -1_100_000,
			cumulative: -1_100_000,
		})
	})

	test("month 2: the branches, 200,000 + 300,000", () => {
		expect(row(2)).toMatchObject({ constructionAndReplacement: 500_000, cashFlow: -500_000, cumulative: -1_600_000 })
	})

	test("month 3: 3 × 5,500 receipts, all credited; 3 × 1,000 + 4,000 service and maintenance; 3 × 30,000 activations; 20,000 working capital", () => {
		// 16,500 − 16,500 − 7,000 − 90,000 − 0 − 20,000 − 0 = −117,000
		expect(row(3)).toMatchObject({
			receipts: 16_500,
			promotion: 16_500,
			serviceAndMaintenance: 7000,
			acquisitionAndActivation: 90_000,
			constructionAndReplacement: 0,
			workingCapitalIncrease: 20_000,
			tax: 0,
			cashFlow: -117_000,
			cumulative: -1_717_000,
		})
	})

	test("month 4: 8 × 5,500 receipts less 5 credits is the first collected revenue", () => {
		// 44,000 − 27,500 − 12,000 − 150,000 = −145,500
		expect(row(4)).toMatchObject({
			receipts: 44_000,
			promotion: 27_500,
			serviceAndMaintenance: 12_000,
			acquisitionAndActivation: 150_000,
			cashFlow: -145_500,
			cumulative: -1_862_500,
		})

		expect(table.firstRevenueMonth).toBe(4)
	})

	test("month 6: the cumulative shortfall reaches its deepest point two months after first revenue", () => {
		// Month 5: 66,000 − 22,000 − 16,000 − 120,000 = −92,000.
		// Month 6: 88,000 − 22,000 − 20,000 − 120,000 = −74,000.
		expect(row(5).cashFlow).toBe(-92_000)
		expect(row(6)).toMatchObject({ cashFlow: -74_000, cumulative: -2_028_500 })
		expect(table.peakFunding).toEqual({ amount: 2_028_500, month: 6 })
		expect(table.cashBeforeFirstRevenue).toBe(1_717_000)
	})
})

describe("churn and promotions", () => {
	test("month 9: A's expected churn reaches (3 + 6 + 9 + 12 + 12 + 12) × 2% = 1.08, so one subscriber leaves and one joins", () => {
		// 110,000 − 5,500 − 24,000 − 30,000 = 50,500
		expect(row(9).buildings[0]).toEqual({
			building: BUILDING_A,
			occupied: 24,
			active: 12,
			newActivations: 1,
			churn: 1,
			joined: 0,
		})

		expect(row(9)).toMatchObject({ active: 20, churn: 1, promotion: 5500, cashFlow: 50_500 })
	})

	test("month 13: both buildings lose one subscriber; B's expected churn is (2 + 3 + 4 + 4 + 8 × 5) × 2% = 1.06", () => {
		// 110,000 − 11,000 − 24,000 − 60,000 = 15,000
		expect(row(13)).toMatchObject({ churn: 2, newActivations: 2, promotion: 11_000, cashFlow: 15_000 })
	})

	test("over 48 months A loses 10 subscribers and B 6, and each is replaced", () => {
		const churnMonths = (index: number) =>
			table.rows.filter((entry) => entry.buildings[index]!.churn > 0).map((entry) => entry.month)

		expect(churnMonths(0)).toEqual([9, 13, 17, 22, 26, 30, 34, 38, 42, 47])
		expect(churnMonths(1)).toEqual([13, 19, 26, 32, 38, 44])
		expect(table.totals).toMatchObject({ churn: 16, newActivations: 36 })
	})

	test("a new activation never exceeds the occupied units left after existing subscribers", () => {
		for (const entry of table.rows) {
			for (const building of entry.buildings) {
				expect(building.active).toBeLessThanOrEqual(building.occupied)
			}
		}
	})
})

describe("discounting and totals", () => {
	test("months 12, 24, 36 and 48 discount by 1.1, 1.21, 1.331 and 1.4641", () => {
		// 86,000 / 1.1 = 78,181.82. 86,000 / 1.21 = 71,074.38. 26,000 / 1.331 = 19,534.18. 86,000 / 1.4641 = 58,739.16.
		expect(
			[12, 24, 36, 48].map((month) => [row(month).discountFactorE8, row(month).cashFlow, row(month).presentValue])
		).toEqual([
			[110_000_000, 86_000, 78_182],
			[121_000_000, 86_000, 71_074],
			[133_100_000, 26_000, 19_534],
			[146_410_000, 86_000, 58_739],
		])
	})

	test("month 36 pays the 60,000 electronics refresh", () => {
		expect(row(36).constructionAndReplacement).toBe(60_000)
	})

	test("the undiscounted cash flow sums to 795,500 and the NPV is the sum of the present-value column", () => {
		// −1,100,000 − 500,000 − 117,000 − 145,500 − 92,000 − 74,000 + 68,000 − 56,000 for months 1 to 8,
		// then 40 months at 86,000, less 16 replacements at 35,500 and the 60,000 refresh: 2,812,000.
		expect(table.totals.cashFlow).toBe(795_500)
		expect(table.npv).toBe(table.rows.reduce((sum, entry) => sum + entry.presentValue, 0))
		expect(table.totals.presentValue).toBe(table.npv)
	})

	test("the base case adds no terminal value after month 48", () => {
		expect(row(48).cashFlow).toBe(86_000)
		expect(table.rows.at(-1)!.month).toBe(48)
	})
})

describe("delayed first revenue", () => {
	test("service from month 9 moves the first credited month to 9 and first revenue to 10", () => {
		const delayed = projectCashFlow(
			prepareScenario(
				dossier,
				withChange(SHARED_ROUTE, (draft) => {
					for (const plan of draft.buildings) {
						plan.serviceFromMonth = 9
					}
				})
			)
		)

		expect(delayed.rows[9]).toMatchObject({ newActivations: 5, receipts: 27_500, promotion: 27_500 })
		expect(delayed.firstRevenueMonth).toBe(10)
		expect(delayed.peakFunding.amount).toBeGreaterThan(table.peakFunding.amount)
	})
})

describe("no build", () => {
	test("keeps the occupied units and holds every flow at zero", () => {
		const none = noBuildCashFlow(prepareScenario(dossier, SHARED_ROUTE))

		expect(none.build).toBe(false)
		expect(none.rows.map((entry) => entry.occupied).slice(0, 9)).toEqual([24, 24, 24, 24, 32, 32, 32, 32, 40])

		expect(none.rows.every((entry) => entry.active === 0 && entry.cashFlow === 0 && entry.presentValue === 0)).toBe(
			true
		)

		expect(none).toMatchObject({ npv: 0, firstRevenueMonth: null, cashBeforeFirstRevenue: 0 })
		expect(none.peakFunding).toEqual({ amount: 0, month: null })
		expect(none.construction.total).toBe(0)
	})
})

describe("existing subscribers and stated payments", () => {
	test("subscribers already served join without activation cost and reduce the new activations needed", () => {
		const migrated = projectCashFlow(
			prepareScenario(
				dossier,
				withChange(SHARED_ROUTE, (draft) => {
					draft.buildings[0]!.existingSubscribers = [{ month: 3, count: 2, basis: SYNTHETIC }]
				})
			)
		)

		// A's month-3 target is 3.
		// Two existing subscribers join, so one new activation remains.
		expect(migrated.rows[3]!.buildings[0]).toMatchObject({ active: 3, joined: 2, newActivations: 1 })
		expect(migrated.rows[3]!.acquisitionAndActivation).toBe(30_000)
	})

	test("existing subscribers above the occupied units are refused", () => {
		const crowded = withChange(SHARED_ROUTE, (draft) => {
			draft.buildings[1]!.existingSubscribers = [{ month: 2, count: 1, basis: SYNTHETIC }]
		})

		expect(() => projectCashFlow(prepareScenario(dossier, crowded))).toThrow(
			expect.objectContaining({ input: ScenarioInput.Subscribers })
		)
	})

	test("stated tax payments enter the tax column in their months", () => {
		const taxed = projectCashFlow(
			prepareScenario(
				dossier,
				withChange(SHARED_ROUTE, (draft) => {
					draft.taxTreatment = {
						kind: TaxTreatmentKind.StatedPayments,
						payments: [
							{
								id: "year-2",
								description: "Stated payment",
								fromMonth: 24,
								toMonth: 24,
								amount: 10_000,
								basis: SYNTHETIC,
							},
						],
					}
				})
			)
		)

		expect(taxed.rows[24]).toMatchObject({ tax: 10_000, cashFlow: 76_000 })
		expect(taxed.totals.tax).toBe(10_000)
	})
})
