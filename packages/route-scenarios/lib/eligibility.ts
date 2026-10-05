/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The buildings a scenario may count, read from a dossier. A selected building enters the scenario only
 *   with its own identity in the dossier and a resolved unit total at the stage its plan names.
 *
 *   An unresolved total stays unresolved. {@link UnresolvedUnitTotalError} holds the dossier's unresolved
 *   total with its reason and conflicting counts, and the scenario computes no cash flow from it. The
 *   calculator never turns such a total into zero units or into a subscriber count.
 *
 *   Two buildings on one parcel keep separate unit counts. A unit membership key that appears in the totals
 *   of two selected buildings would count the same units twice, so {@link SharedUnitMembershipError} refuses it.
 */

import {
	type BuildingSection,
	distinctSources,
	type Dossier,
	type EntityID,
	type ISODate,
	type SourceRecordID,
	type UnitStage,
	type UnitTotal,
} from "@mailwoman/dossier"

import {
	InputBasisKind,
	buildingPlan,
	type Scenario,
	scenarioBases,
	ScenarioInput,
	ScenarioInputError,
	validateScenario,
} from "#scenario"

/**
 * A selected building's eligible units, with the dossier records behind them.
 */
export interface EligibleBuilding {
	building: EntityID
	label: string
	stage: UnitStage
	at: ISODate
	units: number
	sources: readonly SourceRecordID[]
	memberships: readonly string[]
}

type UnresolvedTotal = Extract<UnitTotal, { status: "unresolved" }>

/**
 * A selected building whose dossier unit total is unresolved at the stage its plan names.
 */
export class UnresolvedUnitTotalError extends Error {
	readonly building: EntityID
	readonly total: UnresolvedTotal

	constructor(building: EntityID, label: string, total: UnresolvedTotal) {
		const values = total.conflicting.map((count) => `${count.count} per ${count.evidence.source}`).join(". ")

		super(
			`the ${total.stage} unit total for ${label} (${building}) on ${total.at} is unresolved: ${total.reason}` +
				(values ? ` (${values})` : "") +
				". The scenario computes no units, subscribers or cash flow for it."
		)

		this.name = "UnresolvedUnitTotalError"
		this.building = building
		this.total = total
	}
}

/**
 * A unit membership key that appears in the unit totals of two selected buildings.
 */
export class SharedUnitMembershipError extends Error {
	readonly membership: string
	readonly buildings: readonly EntityID[]

	constructor(membership: string, buildings: readonly EntityID[]) {
		super(
			`the unit membership ${membership} is counted for ${buildings.join(" and ")}. ` +
				"Counting it for each building would count the same units twice."
		)

		this.name = "SharedUnitMembershipError"
		this.membership = membership
		this.buildings = buildings
	}
}

/**
 * A validated scenario bound to the dossier it reads.
 */
export interface PreparedScenario {
	scenario: Scenario
	dossier: Dossier
	/**
	 * The selected buildings in selection order.
	 */
	eligible: readonly EligibleBuilding[]
}

function sectionIndex(dossier: Dossier): ReadonlyMap<EntityID, BuildingSection> {
	return new Map(dossier.buildings.map((section) => [section.building.id, section]))
}

/**
 * Returns each selected building's eligible units from its dossier unit total.
 *
 * Throws {@link UnresolvedUnitTotalError} for an unresolved total and
 * {@link SharedUnitMembershipError} when two selected buildings share a membership key.
 */
export function eligibleBuildings(dossier: Dossier, scenario: Scenario): readonly EligibleBuilding[] {
	const sections = sectionIndex(dossier)
	const owners = new Map<string, EntityID>()
	const eligible: EligibleBuilding[] = []

	for (const building of scenario.selected) {
		const plan = buildingPlan(scenario, building)
		const section = sections.get(building)

		if (!section) {
			throw new ScenarioInputError(
				ScenarioInput.Building,
				`buildings[${building}]`,
				`${building} is not a building in the dossier`
			)
		}

		const total = section.counts[plan.unitStage]

		if (total.status === "unresolved") throw new UnresolvedUnitTotalError(building, section.building.label, total)

		const memberships = [...new Set(total.parts.map((part) => part.membership))]

		for (const membership of memberships) {
			const owner = owners.get(membership)

			if (owner !== undefined) throw new SharedUnitMembershipError(membership, [owner, building])

			owners.set(membership, building)
		}

		eligible.push({
			building,
			label: section.building.label,
			stage: total.stage,
			at: total.at,
			units: total.total,
			sources: distinctSources(total.parts.map((part) => part.evidence.source)),
			memberships,
		})
	}

	return eligible
}

/**
 * Validates `scenario`, checks it against `dossier`, and reads each selected building's eligible units.
 *
 * The dossier checks are these.
 * The scenario's as-of date must equal the dossier's.
 *
 * Every planned building must be a building in the dossier.
 * Every basis that cites a source record must cite one the dossier admitted.
 *
 * Each selected building's unit total must resolve, and its occupancy may never exceed that total.
 */
export function prepareScenario(dossier: Dossier, scenario: Scenario): PreparedScenario {
	validateScenario(scenario)

	if (scenario.asOf !== dossier.asOf) {
		throw new ScenarioInputError(
			ScenarioInput.Date,
			"asOf",
			`the scenario is dated ${scenario.asOf} and the dossier it reads is dated ${dossier.asOf}`
		)
	}

	const sections = sectionIndex(dossier)

	for (const plan of scenario.buildings) {
		if (!sections.has(plan.building)) {
			throw new ScenarioInputError(
				ScenarioInput.Building,
				`buildings[${plan.building}]`,
				`${plan.building} is not a building in the dossier as of ${dossier.asOf}`
			)
		}
	}

	const admitted = new Set(dossier.admitted)
	const excluded = new Map(dossier.excluded.map((record) => [record.id, record.availableAt]))
	const undated = new Set(dossier.undated)

	for (const { path, basis } of scenarioBases(scenario)) {
		if (basis.kind !== InputBasisKind.SourceRecord || admitted.has(basis.source)) continue

		const reason = excluded.has(basis.source)
			? `became available on ${excluded.get(basis.source)}, after the as-of date ${dossier.asOf}`
			: undated.has(basis.source)
				? "has no availability date, so the dossier cannot admit it"
				: "is not a record in the dossier"

		throw new ScenarioInputError(ScenarioInput.Basis, path, `the source record ${basis.source} ${reason}`)
	}

	const eligible = eligibleBuildings(dossier, scenario)

	for (const entry of eligible) {
		for (const [index, step] of buildingPlan(scenario, entry.building).occupancy.entries()) {
			if (step.units > entry.units) {
				throw new ScenarioInputError(
					ScenarioInput.Occupancy,
					`buildings[${entry.building}].occupancy[${index}].units`,
					`${step.units} occupied units exceed the ${entry.units} ${entry.stage} units the dossier records for ${entry.label}`
				)
			}
		}
	}

	return { scenario, dossier, eligible }
}
