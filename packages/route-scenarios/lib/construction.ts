/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Construction cost, charged once per asset. A selection of buildings pays for each distinct route segment
 *   its buildings need once, however many of them share it. Mobilization and shared engineering are project
 *   costs, charged once when the selection holds any building. Each selected building adds its own works in
 *   the months they are paid. Per-customer activation belongs to the monthly cash flow.
 *
 *   The common cost is the route plus the project costs. A building's direct cost is its own works. The
 *   incremental cost of adding a building to a set is the set's total with the building minus the total
 *   without it, so it includes any segment that only the added building needs.
 */

import type { EntityID } from "@mailwoman/dossier"

import type { PreparedScenario } from "#eligibility"
import { applyBasisPoints, BASIS_POINTS_PER_WHOLE, type MinorUnits } from "#money"
import {
	checkCostAdjustment,
	type CostAdjustment,
	type CostLine,
	type Rate,
	rateFor,
	type RouteSegment,
	type Scenario,
	ScenarioInput,
	ScenarioInputError,
} from "#scenario"

/**
 * A cost line with its rate and its amount: the quantity times the rate, after any adjustment.
 */
export interface PricedLine {
	line: CostLine
	rate: Rate
	/**
	 * The quantity times the rate, before any adjustment.
	 */
	listed: MinorUnits
	amount: MinorUnits
}

export interface SegmentCost {
	segment: RouteSegment
	/**
	 * The selected buildings whose route includes this segment, in selection order.
	 */
	usedBy: readonly EntityID[]
	lines: readonly PricedLine[]
	amount: MinorUnits
}

export interface BuildingWorksCost {
	building: EntityID
	lines: readonly PricedLine[]
	amount: MinorUnits
}

export interface ConstructionCost {
	selection: readonly EntityID[]
	adjustment: CostAdjustment | null
	segments: readonly SegmentCost[]
	project: readonly PricedLine[]
	buildings: readonly BuildingWorksCost[]
	route: MinorUnits
	projectTotal: MinorUnits
	common: MinorUnits
	direct: MinorUnits
	total: MinorUnits
}

export interface IncrementalCost {
	base: readonly EntityID[]
	added: EntityID
	before: MinorUnits
	after: MinorUnits
	incremental: MinorUnits
	/**
	 * Segments the added building needs that the base set does not.
	 */
	newSegments: readonly string[]
}

function sum(amounts: Iterable<MinorUnits>): MinorUnits {
	let total = 0

	for (const amount of amounts) {
		total += amount
	}

	return total
}

/**
 * Prices one line: its whole quantity times its rate, then the adjustment if the line's category is listed.
 */
export function priceLine(scenario: Scenario, line: CostLine, adjustment: CostAdjustment | null): PricedLine {
	const rate = rateFor(scenario, line.rate)
	const listed = line.quantity.value * rate.amount

	if (!Number.isSafeInteger(listed)) {
		throw new ScenarioInputError(
			ScenarioInput.Amount,
			line.id,
			`the quantity times the rate exceeds the safe integer range`
		)
	}

	const amount =
		adjustment !== null && adjustment.categories.includes(line.category)
			? applyBasisPoints(listed, BASIS_POINTS_PER_WHOLE + adjustment.basisPoints)
			: listed

	return { line, rate, listed, amount }
}

function checkSelection(scenario: Scenario, selection: readonly EntityID[], path: string): void {
	const seen = new Set<EntityID>()

	for (const [index, building] of selection.entries()) {
		if (!scenario.buildings.some((plan) => plan.building === building)) {
			throw new ScenarioInputError(
				ScenarioInput.Building,
				`${path}[${index}]`,
				`${building} has no plan in scenario ${scenario.id}`
			)
		}

		if (seen.has(building)) {
			throw new ScenarioInputError(ScenarioInput.Building, `${path}[${index}]`, `${building} appears twice`)
		}

		seen.add(building)
	}
}

/**
 * Returns the construction cost of `selection`, which defaults to the scenario's selected buildings.
 *
 * `adjustment` defaults to the scenario's own cost adjustment.
 */
export function constructionCost(
	prepared: PreparedScenario,
	selection: readonly EntityID[] = prepared.scenario.selected,
	adjustment: CostAdjustment | null = prepared.scenario.costAdjustment
): ConstructionCost {
	const { scenario } = prepared

	checkSelection(scenario, selection, "selection")

	if (adjustment !== null) {
		checkCostAdjustment(adjustment, "adjustment")
	}

	const plans = selection.map((building) => scenario.buildings.find((plan) => plan.building === building)!)
	const segmentIDs = [...new Set(plans.flatMap((plan) => plan.route))]

	const segments = segmentIDs.map((id): SegmentCost => {
		const segment = scenario.segments.find((entry) => entry.id === id)!
		const lines = segment.lines.map((line) => priceLine(scenario, line, adjustment))

		return {
			segment,
			usedBy: plans.filter((plan) => plan.route.includes(id)).map((plan) => plan.building),
			lines,
			amount: sum(lines.map((line) => line.amount)),
		}
	})

	const project = selection.length ? scenario.projectCosts.map((line) => priceLine(scenario, line, adjustment)) : []

	const buildings = plans.map((plan): BuildingWorksCost => {
		const lines = plan.works.map((line) => priceLine(scenario, line, adjustment))

		return { building: plan.building, lines, amount: sum(lines.map((line) => line.amount)) }
	})

	const route = sum(segments.map((segment) => segment.amount))
	const projectTotal = sum(project.map((line) => line.amount))
	const direct = sum(buildings.map((building) => building.amount))

	return {
		selection,
		adjustment,
		segments,
		project,
		buildings,
		route,
		projectTotal,
		common: route + projectTotal,
		direct,
		total: route + projectTotal + direct,
	}
}

/**
 * Returns the cost of adding `added` to the set `base`: the total with it minus the total without it.
 */
export function incrementalCost(
	prepared: PreparedScenario,
	base: readonly EntityID[],
	added: EntityID
): IncrementalCost {
	if (base.includes(added)) {
		throw new ScenarioInputError(ScenarioInput.Building, "added", `${added} is already in the set it is added to`)
	}

	const before = constructionCost(prepared, base)
	const after = constructionCost(prepared, [...base, added])
	const known = new Set(before.segments.map((segment) => segment.segment.id))

	return {
		base,
		added,
		before: before.total,
		after: after.total,
		incremental: after.total - before.total,
		newSegments: after.segments.map((segment) => segment.segment.id).filter((id) => !known.has(id)),
	}
}

/**
 * Returns the construction cost by payment month, in month order, with each line counted once.
 */
export function constructionSchedule(cost: ConstructionCost): ReadonlyMap<number, MinorUnits> {
	const lines = [
		...cost.segments.flatMap((segment) => segment.lines),
		...cost.project,
		...cost.buildings.flatMap((building) => building.lines),
	]

	const byMonth = new Map<number, MinorUnits>()

	for (const priced of lines) {
		byMonth.set(priced.line.month, (byMonth.get(priced.line.month) ?? 0) + priced.amount)
	}

	return new Map([...byMonth].toSorted(([a], [b]) => a - b))
}
