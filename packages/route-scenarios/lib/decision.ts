/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The decision outputs of a scenario: the capex range from stated adjustments, the extra construction
 *   spend the NPV target leaves room for, and the take rate the target needs.
 *
 *   An extra construction spend is paid in a stated month, because its month sets its discounted value. The
 *   affordable amount is the largest whole number of minor units that, added to that month's construction,
 *   keeps the NPV at or above the target under the rounding rule of `money.ts`.
 *
 *   A take rate is active subscribers divided by occupied eligible units in a stated month. Activations reach
 *   the scenario's take rate through its uptake rule, so the break-even search varies the uptake's take rate
 *   in whole basis points from 0 to 100 percent and keeps everything else fixed. It reports the lowest one
 *   whose NPV reaches the target, or `unreachable` when 100 percent misses it.
 *
 *   The low and high capex cases are scenarios built from stated adjustments, and no probability is attached
 *   to either.
 */

import { type CashFlowTable, projectCashFlow } from "#cash-flow"
import { constructionCost } from "#construction"
import type { PreparedScenario } from "#eligibility"
import { BASIS_POINTS_PER_WHOLE, type MinorUnits, presentValue } from "#money"
import { checkCostAdjustment, type CostAdjustment, ScenarioInput, ScenarioInputError } from "#scenario"

export type AffordableSpend =
	| {
			status: "within_target"
			month: number
			calendarMonth: string
			discountFactorE8: number
			/**
			 * The largest extra spend in `month` that keeps the NPV at or above the target.
			 */
			amount: MinorUnits
			npv: MinorUnits
			/**
			 * The NPV with `amount` added to the month's construction.
			 */
			npvAfter: MinorUnits
			target: MinorUnits
	  }
	| {
			status: "below_target"
			month: number
			calendarMonth: string
			npv: MinorUnits
			target: MinorUnits
			shortfall: MinorUnits
	  }

export type BreakEvenTakeRate =
	| {
			status: "reached"
			takeRateBasisPoints: number
			month: number
			calendarMonth: string
			/**
			 * Active subscribers and occupied units in `month` at the break-even take rate.
			 */
			active: number
			occupied: number
			npv: MinorUnits
			target: MinorUnits
	  }
	| {
			status: "unreachable"
			month: number
			calendarMonth: string
			target: MinorUnits
			npvAtFullTake: MinorUnits
	  }

export interface CapexCase {
	label: string
	adjustment: CostAdjustment | null
	total: MinorUnits
}

export interface CapexRange {
	low: CapexCase
	base: CapexCase
	high: CapexCase
}

/**
 * Returns the largest extra construction spend in `month` that keeps the table's NPV at or above `target`.
 *
 * Only that month's present value changes, so the search recomputes one rounded value per candidate.
 */
export function affordableExtraSpend(table: CashFlowTable, month: number, target: MinorUnits): AffordableSpend {
	const row = table.rows[month]

	if (!Number.isSafeInteger(month) || !row) {
		throw new ScenarioInputError(
			ScenarioInput.Month,
			"month",
			`month ${month} is outside the table's months 0 to ${table.rows.length - 1}`
		)
	}

	if (table.npv < target) {
		return {
			status: "below_target",
			month,
			calendarMonth: row.calendarMonth,
			npv: table.npv,
			target,
			shortfall: target - table.npv,
		}
	}

	const npvWith = (extra: number) =>
		table.npv - row.presentValue + presentValue(row.cashFlow - extra, row.discountFactorE8)

	let fits = 0
	let misses = 1

	while (npvWith(misses) >= target) {
		fits = misses
		misses *= 2
	}

	while (misses - fits > 1) {
		const middle = Math.floor((fits + misses) / 2)

		if (npvWith(middle) >= target) {
			fits = middle
		} else {
			misses = middle
		}
	}

	return {
		status: "within_target",
		month,
		calendarMonth: row.calendarMonth,
		discountFactorE8: row.discountFactorE8,
		amount: fits,
		npv: table.npv,
		npvAfter: npvWith(fits),
		target,
	}
}

/**
 * Returns `prepared` with the uptake's take rate replaced, and every other input unchanged.
 */
export function withTakeRate(prepared: PreparedScenario, takeRateBasisPoints: number): PreparedScenario {
	if (
		!Number.isSafeInteger(takeRateBasisPoints) ||
		takeRateBasisPoints < 0 ||
		takeRateBasisPoints > BASIS_POINTS_PER_WHOLE
	) {
		throw new ScenarioInputError(
			ScenarioInput.Percentage,
			"takeRateBasisPoints",
			`${takeRateBasisPoints} is outside 0 to ${BASIS_POINTS_PER_WHOLE} basis points`
		)
	}

	const { scenario } = prepared

	return {
		...prepared,
		scenario: {
			...scenario,
			operating: { ...scenario.operating, uptake: { ...scenario.operating.uptake, takeRateBasisPoints } },
		},
	}
}

/**
 * Returns the lowest take rate in whole basis points at which the NPV reaches the scenario's target.
 */
export function breakEvenTakeRate(prepared: PreparedScenario): BreakEvenTakeRate {
	const { scenario } = prepared
	const month = scenario.takeRateMonth
	let last: CashFlowTable | null = null

	for (let basisPoints = 0; basisPoints <= BASIS_POINTS_PER_WHOLE; basisPoints++) {
		last = projectCashFlow(withTakeRate(prepared, basisPoints))

		if (last.npv >= scenario.npvTarget) {
			const row = last.rows[month]!

			return {
				status: "reached",
				takeRateBasisPoints: basisPoints,
				month,
				calendarMonth: row.calendarMonth,
				active: row.active,
				occupied: row.occupied,
				npv: last.npv,
				target: scenario.npvTarget,
			}
		}
	}

	return {
		status: "unreachable",
		month,
		calendarMonth: last!.rows[month]!.calendarMonth,
		target: scenario.npvTarget,
		npvAtFullTake: last!.npv,
	}
}

/**
 * Returns the construction total under the scenario's own rates and under the two stated adjustments.
 *
 * The low case must cost no more than the base case and the high case no less,
 * so a label always matches the direction of its adjustment.
 */
export function capexRange(prepared: PreparedScenario, low: CostAdjustment, high: CostAdjustment): CapexRange {
	checkCostAdjustment(low, "low")
	checkCostAdjustment(high, "high")

	const base: CapexCase = {
		label: prepared.scenario.costAdjustment?.label ?? "rate card as stated",
		adjustment: prepared.scenario.costAdjustment,
		total: constructionCost(prepared).total,
	}

	const range: CapexRange = {
		low: { label: low.label, adjustment: low, total: constructionCost(prepared, undefined, low).total },
		base,
		high: { label: high.label, adjustment: high, total: constructionCost(prepared, undefined, high).total },
	}

	if (range.low.total > base.total) {
		throw new ScenarioInputError(
			ScenarioInput.Field,
			"low",
			`the low case "${low.label}" costs more than the base case`
		)
	}

	if (range.high.total < base.total) {
		throw new ScenarioInputError(
			ScenarioInput.Field,
			"high",
			`the high case "${high.label}" costs less than the base case`
		)
	}

	return range
}
