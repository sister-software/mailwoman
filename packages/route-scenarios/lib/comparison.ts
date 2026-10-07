/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Comparison cases for one scenario. Each case changes one stated assumption of the base case, such as
 *   the first service month, the uptake, the price, the construction rates or the timing of a building's
 *   works, and keeps the same selected buildings and accounting conventions. A case that changes a
 *   convention is refused, because its NPV would then differ for a reason the comparison does not show.
 *
 *   The no-build case keeps the buildings and their occupancy and holds every flow at zero. It is the
 *   baseline the other cases are measured against.
 */

import type { Dossier, EntityID } from "@mailwoman/dossier"

import { calendarMonth, type CashFlowTable, noBuildCashFlow, projectCashFlow } from "#cash-flow"
import { prepareScenario } from "#eligibility"
import { formatBasisPoints, formatMoney, type MinorUnits } from "#money"
import {
	type AmountStep,
	type CostAdjustment,
	type CostLine,
	buildingPlan,
	type Scenario,
	ScenarioInput,
	ScenarioInputError,
	stepAt,
	type Uptake,
} from "#scenario"

export interface ComparisonCase {
	id: string
	label: string
	/**
	 * The assumption that distinguishes this case from the base case.
	 */
	assumption: string
	/**
	 * The case's scenario, or null for the no-build case.
	 */
	scenario: Scenario | null
}

export interface ComparisonRow {
	id: string
	label: string
	assumption: string
	capex: MinorUnits
	npv: MinorUnits
	firstRevenueMonth: number | null
	cashBeforeFirstRevenue: MinorUnits
	peakFunding: { amount: MinorUnits; month: number | null }
	table: CashFlowTable
}

/**
 * The scenario fields a case must share with its base case.
 */
const CONVENTIONS = [
	"origin",
	"asOf",
	"currency",
	"monthZero",
	"horizonMonths",
	"priceBasis",
	"annualDiscountRateBasisPoints",
	"npvTarget",
	"extraSpendMonth",
	"takeRateMonth",
] as const satisfies readonly (keyof Scenario)[]

function checkConventions(base: Scenario, candidate: ComparisonCase, scenario: Scenario): void {
	const path = (field: string) => `cases[${candidate.id}].${field}`

	for (const field of CONVENTIONS) {
		if (scenario[field] !== base[field]) {
			throw new ScenarioInputError(
				ScenarioInput.Convention,
				path(field),
				`the case states ${String(scenario[field])} and the base case states ${String(base[field])}`
			)
		}
	}

	if (scenario.taxTreatment.kind !== base.taxTreatment.kind) {
		throw new ScenarioInputError(
			ScenarioInput.Convention,
			path("taxTreatment.kind"),
			`the case treats tax as ${scenario.taxTreatment.kind} and the base case as ${base.taxTreatment.kind}`
		)
	}

	if (scenario.selected.join("\n") !== base.selected.join("\n")) {
		throw new ScenarioInputError(
			ScenarioInput.Convention,
			path("selected"),
			`the case selects ${scenario.selected.join(", ")} and the base case selects ${base.selected.join(", ")}`
		)
	}
}

function rowFor(entry: { id: string; label: string; assumption: string }, table: CashFlowTable): ComparisonRow {
	return {
		id: entry.id,
		label: entry.label,
		assumption: entry.assumption,
		capex: table.construction.total,
		npv: table.npv,
		firstRevenueMonth: table.firstRevenueMonth,
		cashBeforeFirstRevenue: table.cashBeforeFirstRevenue,
		peakFunding: table.peakFunding,
		table,
	}
}

/**
 * Returns the base case's row followed by one row per case, each computed against `dossier`.
 */
export function compareCases(
	dossier: Dossier,
	base: Scenario,
	cases: readonly ComparisonCase[]
): readonly ComparisonRow[] {
	const prepared = prepareScenario(dossier, base)

	const rows = [
		rowFor({ id: "base", label: "Base case", assumption: "the scenario as stated" }, projectCashFlow(prepared)),
	]

	const seen = new Set(["base"])

	for (const candidate of cases) {
		if (seen.has(candidate.id)) {
			throw new ScenarioInputError(
				ScenarioInput.Identifier,
				`cases[${candidate.id}]`,
				`the case ${candidate.id} appears twice`
			)
		}

		seen.add(candidate.id)

		if (!candidate.scenario) {
			rows.push(rowFor(candidate, noBuildCashFlow(prepared)))

			continue
		}

		checkConventions(base, candidate, candidate.scenario)
		rows.push(rowFor(candidate, projectCashFlow(prepareScenario(dossier, candidate.scenario))))
	}

	return rows
}

function derived(base: Scenario, id: string, label: string, change: Partial<Scenario>): Scenario {
	return { ...base, ...change, id: `${base.id}/${id}`, label: `${base.label}: ${label}` }
}

/**
 * The no-build case: the same buildings and occupancy with no construction and no subscribers.
 */
export function noBuildCase(): ComparisonCase {
	return {
		id: "no-build",
		label: "No build",
		assumption: "no construction and no subscribers, so every flow is zero",
		scenario: null,
	}
}

/**
 * Service in every selected building starts `months` later.
 * Construction keeps its months.
 */
export function delayedAccessCase(base: Scenario, months: number): ComparisonCase {
	if (!Number.isSafeInteger(months) || months < 1) {
		throw new ScenarioInputError(
			ScenarioInput.Month,
			"months",
			`a delay must be a positive whole number of months, got ${months}`
		)
	}

	const selected = new Set(base.selected)

	return {
		id: "delayed-access",
		label: "Delayed access and activation",
		assumption: `service in every selected building starts ${months} months later than in the base case`,
		scenario: derived(base, "delayed-access", "delayed access", {
			buildings: base.buildings.map((plan) =>
				selected.has(plan.building) ? { ...plan, serviceFromMonth: plan.serviceFromMonth + months } : plan
			),
		}),
	}
}

/**
 * Activations reach a lower take rate, or reach it more slowly.
 */
export function slowerUptakeCase(base: Scenario, uptake: Uptake): ComparisonCase {
	const current = base.operating.uptake

	return {
		id: "slower-uptake",
		label: "Slower uptake",
		assumption:
			`activations reach ${formatBasisPoints(uptake.takeRateBasisPoints)} of occupied units over ${uptake.rampMonths} months ` +
			`instead of ${formatBasisPoints(current.takeRateBasisPoints)} over ${current.rampMonths} months`,
		scenario: derived(base, "slower-uptake", "slower uptake", { operating: { ...base.operating, uptake } }),
	}
}

/**
 * The monthly price falls to `step.amount` from `step.fromMonth` on, as a competitor's pricing would force.
 */
export function lowerPriceCase(base: Scenario, step: AmountStep): ComparisonCase {
	const before = stepAt(base.operating.prices, step.fromMonth).amount

	if (step.amount >= before) {
		throw new ScenarioInputError(
			ScenarioInput.Amount,
			"step.amount",
			`${formatMoney(step.amount, base.currency)} does not lower the month-${step.fromMonth} price of ${formatMoney(before, base.currency)}`
		)
	}

	const prices = [...base.operating.prices.filter((entry) => entry.fromMonth < step.fromMonth), step]

	return {
		id: "lower-price",
		label: "Lower competitor-driven price",
		assumption:
			`from month ${step.fromMonth} (${calendarMonth(base.monthZero, step.fromMonth)}) the monthly price is ` +
			`${formatMoney(step.amount, base.currency)} instead of ${formatMoney(before, base.currency)}`,
		scenario: derived(base, "lower-price", "lower price", { operating: { ...base.operating, prices } }),
	}
}

/**
 * Construction lines in the adjustment's categories cost more than the rate card states.
 */
export function costOverrunCase(base: Scenario, adjustment: CostAdjustment): ComparisonCase {
	if (adjustment.basisPoints <= 0) {
		throw new ScenarioInputError(ScenarioInput.Percentage, "adjustment.basisPoints", "an overrun must raise costs")
	}

	return {
		id: "cost-overrun",
		label: "Cost overrun",
		assumption: adjustment.label,
		scenario: derived(base, "cost-overrun", "cost overrun", { costAdjustment: adjustment }),
	}
}

/**
 * Other works and service months for some buildings, such as construction-stage against retrofit timing.
 */
export function timingCase(
	base: Scenario,
	input: {
		id: string
		label: string
		assumption: string
		plans: readonly { building: EntityID; works: readonly CostLine[]; serviceFromMonth: number }[]
	}
): ComparisonCase {
	for (const plan of input.plans) {
		buildingPlan(base, plan.building)
	}

	const replacements = new Map(input.plans.map((plan) => [plan.building, plan]))

	return {
		id: input.id,
		label: input.label,
		assumption: input.assumption,
		scenario: derived(base, input.id, input.label, {
			buildings: base.buildings.map((plan) => {
				const replacement = replacements.get(plan.building)

				return replacement
					? { ...plan, works: replacement.works, serviceFromMonth: replacement.serviceFromMonth }
					: plan
			}),
		}),
	}
}
