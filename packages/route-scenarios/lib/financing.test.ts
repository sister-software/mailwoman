/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, test } from "vitest"

import { projectCashFlow } from "#cash-flow"
import { prepareScenario } from "#eligibility"
import { FinancingKind, financingView } from "#financing"
import { ScenarioInput } from "#scenario"
import {
	FINANCING_FLOWS as FLOWS,
	financingFlow as flow,
	SHARED_ROUTE,
	syntheticDossier,
} from "#test/fixtures/shared-route"

const table = projectCashFlow(prepareScenario(syntheticDossier(), SHARED_ROUTE))

describe("a financing view over the unfinanced table", () => {
	const view = financingView(table, FLOWS)

	test("adds each flow once: 800,000 equity, 1,000,000 drawn and repaid, 300,000 granted, 47 × 5,000 interest", () => {
		expect(view.totals).toEqual({
			projectCashFlow: 795_500,
			debtDraws: 1_000_000,
			debtRepayments: 1_000_000,
			interest: 235_000,
			grants: 300_000,
			equity: 800_000,
			netCashFlow: 795_500 + 800_000 + 1_000_000 + 300_000 - 1_000_000 - 235_000,
		})
	})

	test("reconciles month by month: net cash flow less the financing flows is the project table's cash flow", () => {
		expect(view.reconciles).toBe(true)

		for (const [month, entry] of view.rows.entries()) {
			const financing = entry.debtDraws - entry.debtRepayments - entry.interest + entry.grants + entry.equity

			expect(entry.projectCashFlow).toBe(table.rows[month]!.cashFlow)
			expect(entry.netCashFlow - financing).toBe(entry.projectCashFlow)
		}
	})

	test("month 2: −500,000 of branches, a 300,000 grant and 5,000 of interest leave 495,000 of cash", () => {
		// Month 0: 800,000.
		// Month 1: 800,000 − 1,100,000 + 1,000,000 = 700,000.
		// Month 2: 700,000 − 500,000 + 300,000 − 5,000.
		expect(view.rows[2]).toMatchObject({ netCashFlow: -205_000, cashBalance: 495_000, debtOutstanding: 1_000_000 })
	})

	test("the debt is repaid by month 48 and the project table's NPV is unchanged", () => {
		expect(view.rows[48]!.debtOutstanding).toBe(0)
		expect(view.fundingGap).toBeNull()
		expect(table.npv).toBe(267_608)
	})
})

describe("a funding gap", () => {
	test("USD 4,000.00 of equity runs out in month 3: 400,000 − 100,000 − 205,000 − 122,000 = −27,000", () => {
		const short = financingView(table, [flow("equity", FinancingKind.Equity, 0, 0, 400_000), ...FLOWS.slice(1)])

		expect(short.fundingGap).toEqual({ month: 3, calendarMonth: "2027-01", balance: -27_000 })
	})
})

describe("refused financing inputs", () => {
	test("a grant listed twice", () => {
		expect(() => financingView(table, [...FLOWS, flow("grant", FinancingKind.Grant, 3, 3, 300_000)])).toThrow(
			expect.objectContaining({ input: ScenarioInput.Identifier, path: "financing[grant]" })
		)
	})

	test("repayments above the amount drawn", () => {
		expect(() => financingView(table, [...FLOWS, flow("repay-5", FinancingKind.DebtRepayment, 48, 48, 1)])).toThrow(
			expect.objectContaining({ input: ScenarioInput.Amount })
		)
	})

	test("a flow after the horizon", () => {
		expect(() => financingView(table, [flow("late", FinancingKind.Equity, 49, 49, 1)])).toThrow(
			expect.objectContaining({ input: ScenarioInput.Month })
		)
	})
})
