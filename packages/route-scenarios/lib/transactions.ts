/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Optional transaction cases: an acquisition, a lease, wholesale access or a salvage sale. Each case states
 *   its integration month, the obligations it assumes and the proceeds it brings. The base case is unchanged.
 *
 *   Four rules keep a case from counting an asset twice. A leased segment leaves the construction cost, and
 *   its lease payments are the case's obligations. Acquired subscribers join a selected building as existing
 *   subscribers. They take no activation cost, never count as new activations, and never exceed the
 *   building's occupied units. Salvage proceeds arrive in the horizon's last month only, because a plant sold
 *   earlier would still earn in the later months of the table. An adjacent building enters a scenario only as
 *   a planned building with its own identity and unit evidence, and a transaction case has no field for an
 *   expansion value.
 *
 *   Each month reconciles. The base cash flow plus the avoided construction, the change in subscriber flows
 *   and the proceeds, minus the obligations, equals the case's cash flow.
 */

import type { EntityID } from "@mailwoman/dossier"

import { type CashFlowTable, projectCashFlow } from "#cash-flow"
import { constructionCost } from "#construction"
import { type PreparedScenario, prepareScenario } from "#eligibility"
import { type MinorUnits, presentValue } from "#money"
import {
	amountInMonth,
	checkBasis,
	checkScheduledAmounts,
	type InputBasis,
	type ScheduledAmount,
	ScenarioInput,
	ScenarioInputError,
} from "#scenario"

/**
 * The kinds of transaction case, as wire values.
 */
export const TransactionKind = {
	Acquisition: "acquisition",
	Lease: "lease",
	Wholesale: "wholesale",
	Salvage: "salvage",
} as const

export type TransactionKind = (typeof TransactionKind)[keyof typeof TransactionKind]

export interface TransactionCase {
	id: string
	kind: TransactionKind
	label: string
	/**
	 * The month the transaction takes effect: acquired subscribers join, a lease starts,
	 * wholesale begins or the plant is sold.
	 */
	integrationMonth: number
	/**
	 * Payments the case assumes, such as a purchase price, lease payments or an inherited contract.
	 */
	obligations: readonly ScheduledAmount[]
	/**
	 * Money the case brings in, such as wholesale fees or salvage proceeds.
	 */
	proceeds: readonly ScheduledAmount[]
	/**
	 * Route segments used under lease instead of built.
	 * Only a lease names them.
	 */
	leasedSegments: readonly string[]
	/**
	 * Subscribers acquired with the transaction, joining at the integration month.
	 * Only an acquisition names them.
	 */
	acquiredSubscribers: readonly { building: EntityID; count: number }[]
	basis: InputBasis
}

export interface TransactionRow {
	month: number
	calendarMonth: string
	baseCashFlow: MinorUnits
	/**
	 * Construction the case does not pay, such as a leased segment's lines.
	 */
	avoidedConstruction: MinorUnits
	/**
	 * The change in receipts, credits, service and activation from acquired subscribers.
	 */
	subscriberChange: MinorUnits
	obligations: MinorUnits
	proceeds: MinorUnits
	caseCashFlow: MinorUnits
	presentValue: MinorUnits
}

export interface TransactionTotals {
	baseCashFlow: MinorUnits
	avoidedConstruction: MinorUnits
	subscriberChange: MinorUnits
	obligations: MinorUnits
	proceeds: MinorUnits
	caseCashFlow: MinorUnits
}

export interface TransactionView {
	transaction: TransactionCase
	/**
	 * The project table after the case's leased segments and acquired subscribers,
	 * before its obligations and proceeds.
	 */
	adjusted: CashFlowTable
	rows: readonly TransactionRow[]
	totals: TransactionTotals
	npv: MinorUnits
	baseNPV: MinorUnits
	/**
	 * True when every month's parts add up to the case's cash flow and the case
	 * leaves working capital and tax unchanged.
	 */
	reconciles: boolean
}

const KINDS: ReadonlySet<string> = new Set(Object.values(TransactionKind))

function refuse(input: ScenarioInput, path: string, message: string): never {
	throw new ScenarioInputError(input, path, message)
}

function checkTransaction(prepared: PreparedScenario, transaction: TransactionCase): void {
	const { scenario } = prepared
	const horizon = scenario.horizonMonths
	const at = `transactions[${transaction.id}]`

	if (typeof transaction.id !== "string" || transaction.id === "") {
		refuse(ScenarioInput.Identifier, "transactions", "the identifier is missing")
	}

	if (!KINDS.has(transaction.kind)) {
		refuse(ScenarioInput.Field, `${at}.kind`, `${String(transaction.kind)} is not a transaction kind`)
	}

	if (
		!Number.isSafeInteger(transaction.integrationMonth) ||
		transaction.integrationMonth < 0 ||
		transaction.integrationMonth > horizon
	) {
		refuse(
			ScenarioInput.Month,
			`${at}.integrationMonth`,
			`${transaction.integrationMonth} is outside months 0 to ${horizon}`
		)
	}

	const seen = new Set<string>()
	checkScheduledAmounts(transaction.obligations, `${at}.obligations`, horizon, seen, { minimum: 1 })
	checkScheduledAmounts(transaction.proceeds, `${at}.proceeds`, horizon, seen, { minimum: 1 })
	checkBasis(transaction.basis, `${at}.basis`)

	const isLease = transaction.kind === TransactionKind.Lease
	const isAcquisition = transaction.kind === TransactionKind.Acquisition

	if (isLease !== transaction.leasedSegments.length > 0) {
		refuse(
			ScenarioInput.Segment,
			`${at}.leasedSegments`,
			isLease ? "a lease names no segment" : "only a lease names leased segments"
		)
	}

	if (isAcquisition !== transaction.acquiredSubscribers.length > 0) {
		refuse(
			ScenarioInput.Subscribers,
			`${at}.acquiredSubscribers`,
			isAcquisition ? "an acquisition names no subscribers" : "only an acquisition names acquired subscribers"
		)
	}

	const used = new Set(constructionCost(prepared).segments.map((entry) => entry.segment.id))
	const leased = new Set<string>()

	for (const [index, segment] of transaction.leasedSegments.entries()) {
		if (!used.has(segment)) {
			refuse(
				ScenarioInput.Segment,
				`${at}.leasedSegments[${index}]`,
				`the selected buildings use no segment ${segment}`
			)
		}

		if (leased.has(segment)) {
			refuse(ScenarioInput.Segment, `${at}.leasedSegments[${index}]`, `${segment} is leased twice`)
		}

		leased.add(segment)
	}

	const acquired = new Set<EntityID>()

	for (const [index, entry] of transaction.acquiredSubscribers.entries()) {
		const path = `${at}.acquiredSubscribers[${index}]`

		if (!scenario.selected.includes(entry.building)) {
			refuse(ScenarioInput.Building, path, `${entry.building} is not a selected building`)
		}

		if (acquired.has(entry.building)) {
			refuse(ScenarioInput.Building, path, `${entry.building} is listed twice`)
		}

		if (!Number.isSafeInteger(entry.count) || entry.count < 1) {
			refuse(ScenarioInput.Subscribers, `${path}.count`, `${entry.count} is not a positive count`)
		}

		acquired.add(entry.building)
	}

	if (
		(transaction.kind === TransactionKind.Wholesale || transaction.kind === TransactionKind.Salvage) &&
		!transaction.proceeds.length
	) {
		refuse(ScenarioInput.Amount, `${at}.proceeds`, `a ${transaction.kind} case states no proceeds`)
	}

	if (transaction.kind === TransactionKind.Salvage) {
		if (transaction.integrationMonth !== horizon) {
			refuse(ScenarioInput.Month, `${at}.integrationMonth`, `salvage takes effect in the last month, ${horizon}`)
		}

		for (const entry of transaction.proceeds) {
			if (entry.fromMonth !== horizon || entry.toMonth !== horizon) {
				refuse(
					ScenarioInput.Month,
					`${at}.proceeds[${entry.id}]`,
					`salvage proceeds arrive in the last month, ${horizon}`
				)
			}
		}
	}
}

/**
 * Returns the transaction case's months beside the base case's, reconciled month by month.
 */
export function transactionView(prepared: PreparedScenario, transaction: TransactionCase): TransactionView {
	checkTransaction(prepared, transaction)

	const { scenario } = prepared
	const leased = new Set(transaction.leasedSegments)
	const acquired = new Map(transaction.acquiredSubscribers.map((entry) => [entry.building, entry.count]))

	const adjustedScenario = {
		...scenario,
		buildings: scenario.buildings.map((plan) => {
			const count = acquired.get(plan.building)

			return {
				...plan,
				route: plan.route.filter((segment) => !leased.has(segment)),
				existingSubscribers:
					count === undefined
						? plan.existingSubscribers
						: [...plan.existingSubscribers, { month: transaction.integrationMonth, count, basis: transaction.basis }],
			}
		}),
	}

	const base = projectCashFlow(prepared)
	const adjusted = projectCashFlow(prepareScenario(prepared.dossier, adjustedScenario))
	const rows: TransactionRow[] = []
	let reconciles = true

	for (const [month, after] of adjusted.rows.entries()) {
		const before = base.rows[month]!

		const operating = (row: typeof before) =>
			row.receipts - row.promotion - row.serviceAndMaintenance - row.acquisitionAndActivation

		const avoidedConstruction = before.constructionAndReplacement - after.constructionAndReplacement
		const subscriberChange = operating(after) - operating(before)
		const obligations = amountInMonth(transaction.obligations, month)
		const proceeds = amountInMonth(transaction.proceeds, month)
		const caseCashFlow = after.cashFlow - obligations + proceeds

		reconciles &&=
			before.cashFlow + avoidedConstruction + subscriberChange - obligations + proceeds === caseCashFlow &&
			before.workingCapitalIncrease === after.workingCapitalIncrease &&
			before.tax === after.tax

		rows.push({
			month,
			calendarMonth: after.calendarMonth,
			baseCashFlow: before.cashFlow,
			avoidedConstruction,
			subscriberChange,
			obligations,
			proceeds,
			caseCashFlow,
			presentValue: presentValue(caseCashFlow, after.discountFactorE8),
		})
	}

	const column = (key: keyof TransactionTotals) => rows.reduce((sum, row) => sum + row[key], 0)

	return {
		transaction,
		adjusted,
		rows,
		totals: {
			baseCashFlow: column("baseCashFlow"),
			avoidedConstruction: column("avoidedConstruction"),
			subscriberChange: column("subscriberChange"),
			obligations: column("obligations"),
			proceeds: column("proceeds"),
			caseCashFlow: column("caseCashFlow"),
		},
		npv: rows.reduce((sum, row) => sum + row.presentValue, 0),
		baseNPV: base.npv,
		reconciles,
	}
}
