/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The monthly unfinanced cash-flow table, from month 0 through the horizon.
 *
 *   Each selected building keeps three counts apart: occupied eligible units, active subscribers, and the
 *   month's new activations, churn and joining existing subscribers. Provider availability is a dossier
 *   fact and enters the table only through a building's first service month. All counts are whole
 *   subscribers. Churn in a month is the floor of the building's cumulative expected churn (the sum of each
 *   earlier month's closing subscribers times the monthly churn rate) minus the churn already applied.
 *   New activations fill the gap to the month's target and never exceed the occupied units left after the
 *   building's existing subscribers.
 *
 *   A month's cash flow is its receipts minus promotion credits, service and maintenance, acquisition and
 *   activation, construction and replacement, the working-capital increase and tax. Receipts are each
 *   active subscriber's price, collected in the month of service. A promotion credit is a stated share of the
 *   month's price. It reduces what a new subscriber pays in the activation month and appears as a cost. First
 *   revenue is the first month whose receipts exceed its credits. Peak funding is the deepest point of the
 *   cumulative cash flow. That point can fall after first revenue. The base case adds no terminal value after
 *   the horizon.
 *
 *   The discount rule is the one in `money.ts`. Each row holds its factor and its present value, and NPV is
 *   the sum of the present values.
 */

import type { EntityID } from "@mailwoman/dossier"

import { constructionCost, type ConstructionCost, constructionSchedule, priceLine } from "#construction"
import type { PreparedScenario } from "#eligibility"
import {
	applyBasisPoints,
	BASIS_POINTS_PER_WHOLE,
	discountFactorE8,
	type MinorUnits,
	monthlyDiscountRate,
	presentValue,
} from "#money"
import {
	amountInMonth,
	buildingPlan,
	rateFor,
	type Scenario,
	ScenarioInput,
	ScenarioInputError,
	stepAt,
	TaxTreatmentKind,
} from "#scenario"

/**
 * One building's counts in one month.
 */
export interface BuildingMonth {
	building: EntityID
	occupied: number
	active: number
	newActivations: number
	churn: number
	/**
	 * The number of existing subscribers who join the network this month.
	 */
	joined: number
}

export interface CashFlowRow {
	month: number
	/**
	 * The calendar month as `YYYY-MM`.
	 */
	calendarMonth: string
	occupied: number
	active: number
	newActivations: number
	churn: number
	joined: number
	receipts: MinorUnits
	promotion: MinorUnits
	serviceAndMaintenance: MinorUnits
	acquisitionAndActivation: MinorUnits
	constructionAndReplacement: MinorUnits
	workingCapitalIncrease: MinorUnits
	tax: MinorUnits
	cashFlow: MinorUnits
	cumulative: MinorUnits
	/**
	 * The discount factor rounded to eight decimal places, as an integer count of one hundred-millionths.
	 */
	discountFactorE8: number
	presentValue: MinorUnits
	buildings: readonly BuildingMonth[]
}

export interface CashFlowTotals {
	newActivations: number
	churn: number
	joined: number
	receipts: MinorUnits
	promotion: MinorUnits
	serviceAndMaintenance: MinorUnits
	acquisitionAndActivation: MinorUnits
	constructionAndReplacement: MinorUnits
	workingCapitalIncrease: MinorUnits
	tax: MinorUnits
	cashFlow: MinorUnits
	presentValue: MinorUnits
}

export interface CashFlowTable {
	scenarioID: string
	/**
	 * False for the no-build case.
	 * Every flow of that case is zero.
	 */
	build: boolean
	currency: string
	construction: ConstructionCost
	rows: readonly CashFlowRow[]
	totals: CashFlowTotals
	monthlyDiscountRate: number
	npv: MinorUnits
	/**
	 * The first month whose receipts exceed its promotion credits, or null within the horizon.
	 */
	firstRevenueMonth: number | null
	/**
	 * The deepest cumulative shortfall before first revenue.
	 * Without revenue in the horizon, it covers every month.
	 */
	cashBeforeFirstRevenue: MinorUnits
	/**
	 * The deepest cumulative shortfall over the horizon and the first month it is reached.
	 */
	peakFunding: { amount: MinorUnits; month: number | null }
}

/**
 * Returns `month` months after the calendar month of `monthZero`, as `YYYY-MM`.
 */
export function calendarMonth(monthZero: string, month: number): string {
	const [year, calendar] = monthZero.split("-").map(Number)
	const index = year! * 12 + (calendar! - 1) + month

	return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`
}

/**
 * Returns `numerator / denominator` rounded down, exactly, for non-negative safe integers.
 */
function floorDivide(numerator: number, denominator: number): number {
	return (numerator - (numerator % denominator)) / denominator
}

function total(values: Iterable<number>): number {
	let sum = 0

	for (const value of values) {
		sum += value
	}

	return sum
}

/**
 * Each selected building's monthly counts from month 0 through the horizon.
 */
function subscriberPaths(prepared: PreparedScenario): readonly (readonly BuildingMonth[])[] {
	const { scenario } = prepared
	const { uptake, monthlyChurn } = scenario.operating

	return prepared.eligible.map((entry) => {
		const plan = buildingPlan(scenario, entry.building)
		const months: BuildingMonth[] = []
		let active = 0
		let expectedChurn = 0
		let churned = 0

		for (let month = 0; month <= scenario.horizonMonths; month++) {
			const occupied = stepAt(plan.occupancy, month).units

			expectedChurn += active * monthlyChurn.basisPoints
			const whole = floorDivide(expectedChurn, BASIS_POINTS_PER_WHOLE)
			const churn = whole - churned
			churned = whole

			const joined = total(plan.existingSubscribers.filter((step) => step.month === month).map((step) => step.count))
			const retained = active - churn + joined

			if (retained > occupied) {
				throw new ScenarioInputError(
					ScenarioInput.Subscribers,
					`buildings[${plan.building}].existingSubscribers`,
					`${retained} subscribers in month ${month} exceed the ${occupied} occupied units of ${entry.label}`
				)
			}

			let newActivations = 0

			if (month >= plan.serviceFromMonth) {
				const step = Math.min(month - plan.serviceFromMonth + 1, uptake.rampMonths)

				const target = floorDivide(
					uptake.takeRateBasisPoints * occupied * step,
					BASIS_POINTS_PER_WHOLE * uptake.rampMonths
				)

				newActivations = Math.max(0, target - retained)
			}

			active = retained + newActivations
			months.push({ building: plan.building, occupied, active, newActivations, churn, joined })
		}

		return months
	})
}

function workingCapitalBalance(scenario: Scenario, month: number): MinorUnits {
	let balance = 0

	for (const step of scenario.workingCapital)
		if (step.fromMonth <= month) {
			balance = step.balance
		}

	return balance
}

function summarize(
	scenario: Scenario,
	construction: ConstructionCost,
	rows: readonly CashFlowRow[],
	monthly: number,
	build: boolean
): CashFlowTable {
	const column = (key: keyof CashFlowTotals) => total(rows.map((row) => row[key]))

	const totals: CashFlowTotals = {
		newActivations: column("newActivations"),
		churn: column("churn"),
		joined: column("joined"),
		receipts: column("receipts"),
		promotion: column("promotion"),
		serviceAndMaintenance: column("serviceAndMaintenance"),
		acquisitionAndActivation: column("acquisitionAndActivation"),
		constructionAndReplacement: column("constructionAndReplacement"),
		workingCapitalIncrease: column("workingCapitalIncrease"),
		tax: column("tax"),
		cashFlow: column("cashFlow"),
		presentValue: column("presentValue"),
	}

	const firstRevenueMonth = rows.find((row) => row.receipts - row.promotion > 0)?.month ?? null
	const beforeRevenue = firstRevenueMonth === null ? rows : rows.filter((row) => row.month < firstRevenueMonth)
	const deepest = (candidates: readonly CashFlowRow[]) => Math.min(0, ...candidates.map((row) => row.cumulative))
	const lowest = deepest(rows)

	return {
		scenarioID: scenario.id,
		build,
		currency: scenario.currency,
		construction,
		rows,
		totals,
		monthlyDiscountRate: monthly,
		npv: totals.presentValue,
		firstRevenueMonth,
		cashBeforeFirstRevenue: Math.max(0, -deepest(beforeRevenue)),
		peakFunding:
			lowest < 0
				? { amount: -lowest, month: rows.find((row) => row.cumulative === lowest)!.month }
				: { amount: 0, month: null },
	}
}

/**
 * Returns the monthly unfinanced cash-flow table of the scenario's selected buildings.
 */
export function projectCashFlow(prepared: PreparedScenario): CashFlowTable {
	const { scenario } = prepared
	const { operating } = scenario
	const construction = constructionCost(prepared)
	const schedule = constructionSchedule(construction)
	const replacements = scenario.replacements.map((line) => priceLine(scenario, line, scenario.costAdjustment))
	const paths = subscriberPaths(prepared)

	const perActivation =
		rateFor(scenario, operating.activationRate).amount + rateFor(scenario, operating.acquisitionRate).amount

	const perSubscriber = rateFor(scenario, operating.serviceRate).amount
	const maintenance = rateFor(scenario, operating.maintenance.rate).amount
	const monthly = monthlyDiscountRate(scenario.annualDiscountRateBasisPoints)
	const rows: CashFlowRow[] = []
	let cumulative = 0
	let previousBalance = 0

	for (let month = 0; month <= scenario.horizonMonths; month++) {
		const buildings = paths.map((path) => path[month]!)
		const active = total(buildings.map((entry) => entry.active))
		const newActivations = total(buildings.map((entry) => entry.newActivations))
		const price = stepAt(operating.prices, month).amount
		const receipts = active * price
		const promotion = newActivations * applyBasisPoints(price, operating.promotion.basisPoints)
		const serviceAndMaintenance = active * perSubscriber + (month >= operating.maintenance.fromMonth ? maintenance : 0)
		const acquisitionAndActivation = newActivations * perActivation

		const constructionAndReplacement =
			(schedule.get(month) ?? 0) +
			total(replacements.filter((priced) => priced.line.month === month).map((priced) => priced.amount))

		const balance = workingCapitalBalance(scenario, month)
		const workingCapitalIncrease = balance - previousBalance
		previousBalance = balance

		const tax =
			scenario.taxTreatment.kind === TaxTreatmentKind.StatedPayments
				? amountInMonth(scenario.taxTreatment.payments, month)
				: 0

		const cashFlow =
			receipts -
			promotion -
			serviceAndMaintenance -
			acquisitionAndActivation -
			constructionAndReplacement -
			workingCapitalIncrease -
			tax

		cumulative += cashFlow
		const factor = discountFactorE8(monthly, month)

		rows.push({
			month,
			calendarMonth: calendarMonth(scenario.monthZero, month),
			occupied: total(buildings.map((entry) => entry.occupied)),
			active,
			newActivations,
			churn: total(buildings.map((entry) => entry.churn)),
			joined: total(buildings.map((entry) => entry.joined)),
			receipts,
			promotion,
			serviceAndMaintenance,
			acquisitionAndActivation,
			constructionAndReplacement,
			workingCapitalIncrease,
			tax,
			cashFlow,
			cumulative,
			discountFactorE8: factor,
			presentValue: presentValue(cashFlow, factor),
			buildings,
		})
	}

	return summarize(scenario, construction, rows, monthly, true)
}

/**
 * Returns the no-build table for the same buildings and months: occupied units as the
 * plans state them, and no construction, subscribers or cash flow.
 */
export function noBuildCashFlow(prepared: PreparedScenario): CashFlowTable {
	const { scenario } = prepared
	const plans = prepared.eligible.map((entry) => buildingPlan(scenario, entry.building))
	const monthly = monthlyDiscountRate(scenario.annualDiscountRateBasisPoints)
	const rows: CashFlowRow[] = []

	for (let month = 0; month <= scenario.horizonMonths; month++) {
		const buildings = plans.map((plan) => ({
			building: plan.building,
			occupied: stepAt(plan.occupancy, month).units,
			active: 0,
			newActivations: 0,
			churn: 0,
			joined: 0,
		}))

		rows.push({
			month,
			calendarMonth: calendarMonth(scenario.monthZero, month),
			occupied: total(buildings.map((entry) => entry.occupied)),
			active: 0,
			newActivations: 0,
			churn: 0,
			joined: 0,
			receipts: 0,
			promotion: 0,
			serviceAndMaintenance: 0,
			acquisitionAndActivation: 0,
			constructionAndReplacement: 0,
			workingCapitalIncrease: 0,
			tax: 0,
			cashFlow: 0,
			cumulative: 0,
			discountFactorE8: discountFactorE8(monthly, month),
			presentValue: 0,
			buildings,
		})
	}

	return summarize(scenario, constructionCost(prepared, []), rows, monthly, false)
}
