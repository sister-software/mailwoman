/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The optional financing view. The project table is unfinanced, and this view adds debt draws, debt
 *   repayments, interest payments, grant receipts and equity contributions beside it without changing it.
 *   Each flow has its own identifier and enters once in each month of its range. A grant therefore appears
 *   here and never as a project receipt.
 *
 *   Every month reconciles: the net cash flow minus the month's financing flows equals the project table's
 *   cash flow for that month. The cash balance is the cumulative net cash flow, and the first month it falls
 *   below zero is reported as a funding gap.
 */

import type { CashFlowTable } from "#cash-flow"
import type { MinorUnits } from "#money"
import {
	amountInMonth,
	checkScheduledAmounts,
	type ScheduledAmount,
	ScenarioInput,
	ScenarioInputError,
} from "#scenario"

/**
 * The kinds of financing flow, as wire values.
 */
export const FinancingKind = {
	DebtDraw: "debt_draw",
	DebtRepayment: "debt_repayment",
	Interest: "interest",
	Grant: "grant",
	Equity: "equity",
} as const

export type FinancingKind = (typeof FinancingKind)[keyof typeof FinancingKind]

/**
 * A financing amount paid or received in each month of its range.
 * Amounts are positive, and the kind sets the sign.
 */
export interface FinancingFlow extends ScheduledAmount {
	kind: FinancingKind
}

export interface FinancingRow {
	month: number
	calendarMonth: string
	projectCashFlow: MinorUnits
	debtDraws: MinorUnits
	debtRepayments: MinorUnits
	interest: MinorUnits
	grants: MinorUnits
	equity: MinorUnits
	netCashFlow: MinorUnits
	cashBalance: MinorUnits
	debtOutstanding: MinorUnits
}

export interface FinancingTotals {
	projectCashFlow: MinorUnits
	debtDraws: MinorUnits
	debtRepayments: MinorUnits
	interest: MinorUnits
	grants: MinorUnits
	equity: MinorUnits
	netCashFlow: MinorUnits
}

export interface FinancingView {
	flows: readonly FinancingFlow[]
	rows: readonly FinancingRow[]
	totals: FinancingTotals
	/**
	 * True when every month's net cash flow minus its financing flows equals the project table's cash flow.
	 */
	reconciles: boolean
	/**
	 * The first month whose cash balance is below zero, or null when the financing covers every month.
	 */
	fundingGap: { month: number; calendarMonth: string; balance: MinorUnits } | null
}

const KINDS: ReadonlySet<string> = new Set(Object.values(FinancingKind))

/**
 * Returns the financing view of `table` with `flows` added.
 */
export function financingView(table: CashFlowTable, flows: readonly FinancingFlow[]): FinancingView {
	const horizon = table.rows.length - 1

	checkScheduledAmounts(flows, "financing", horizon, new Set(), { minimum: 1 })

	for (const entry of flows) {
		if (!KINDS.has(entry.kind)) {
			throw new ScenarioInputError(
				ScenarioInput.Field,
				`financing[${entry.id}].kind`,
				`${String(entry.kind)} is not a financing kind`
			)
		}
	}

	const ofKind = (kind: FinancingKind) => flows.filter((entry) => entry.kind === kind)
	const draws = ofKind(FinancingKind.DebtDraw)
	const repayments = ofKind(FinancingKind.DebtRepayment)
	const interest = ofKind(FinancingKind.Interest)
	const grants = ofKind(FinancingKind.Grant)
	const equity = ofKind(FinancingKind.Equity)

	const rows: FinancingRow[] = []
	let cashBalance = 0
	let debtOutstanding = 0
	let reconciles = true
	let fundingGap: FinancingView["fundingGap"] = null

	for (const projectRow of table.rows) {
		const { month } = projectRow

		const row = {
			month,
			calendarMonth: projectRow.calendarMonth,
			projectCashFlow: projectRow.cashFlow,
			debtDraws: amountInMonth(draws, month),
			debtRepayments: amountInMonth(repayments, month),
			interest: amountInMonth(interest, month),
			grants: amountInMonth(grants, month),
			equity: amountInMonth(equity, month),
		}

		const financing = row.debtDraws - row.debtRepayments - row.interest + row.grants + row.equity
		const netCashFlow = row.projectCashFlow + financing

		debtOutstanding += row.debtDraws - row.debtRepayments

		if (debtOutstanding < 0) {
			throw new ScenarioInputError(
				ScenarioInput.Amount,
				"financing",
				`repayments through month ${month} exceed the amount drawn by ${-debtOutstanding} minor units`
			)
		}

		cashBalance += netCashFlow
		reconciles &&= netCashFlow - financing === projectRow.cashFlow

		if (fundingGap === null && cashBalance < 0) {
			fundingGap = { month, calendarMonth: projectRow.calendarMonth, balance: cashBalance }
		}

		rows.push({ ...row, netCashFlow, cashBalance, debtOutstanding })
	}

	const column = (key: keyof FinancingTotals) => rows.reduce((sum, row) => sum + row[key], 0)

	return {
		flows,
		rows,
		totals: {
			projectCashFlow: column("projectCashFlow"),
			debtDraws: column("debtDraws"),
			debtRepayments: column("debtRepayments"),
			interest: column("interest"),
			grants: column("grants"),
			equity: column("equity"),
			netCashFlow: column("netCashFlow"),
		},
		reconciles,
		fundingGap,
	}
}
