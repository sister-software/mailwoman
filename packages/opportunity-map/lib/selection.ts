/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The economics of a selection of buildings, and the totals of a portfolio of projects. A selection's
 *   figures come from one calculation in `@mailwoman/route-scenarios` over the whole selection: its eligible
 *   units, the construction cost with each shared segment charged once, NPV, first revenue and funding. The
 *   model never adds standalone building estimates, because a shared segment would then be charged once
 *   for each building that uses it.
 *
 *   A portfolio is a set of projects, each a selection from one scenario. Its totals are the sums of the
 *   projects' figures, so they count only projects that share no building and no segment. A portfolio
 *   whose projects overlap throws {@link OverlappingProjectsError}. The error lists each overlapping pair
 *   of projects with the buildings and segments the pair shares.
 */

import { type Dossier, type EntityID, proseList } from "@mailwoman/dossier"
import {
	buildingPlan,
	type EligibleBuilding,
	type InputOrigin,
	type MinorUnits,
	prepareScenario,
	projectCashFlow,
	type Scenario,
} from "@mailwoman/route-scenarios"

import { MapInputError } from "#inputs"

export interface SelectionEconomics {
	/**
	 * The scenario's identifier.
	 */
	scenario: string
	selection: readonly EntityID[]
	currency: string
	origin: InputOrigin
	/**
	 * `true` when the scenario's inputs are synthetic.
	 */
	synthetic: boolean
	/**
	 * Each selected building's eligible units, read from its dossier unit total.
	 */
	eligible: readonly EligibleBuilding[]
	/**
	 * The sum of the selected buildings' eligible units, each building counted once.
	 */
	units: number
	/**
	 * The segments the selection uses, each with the selected buildings that use it
	 * and its cost, charged once.
	 */
	segments: readonly { segment: string; usedBy: readonly EntityID[]; amount: MinorUnits }[]
	construction: { route: MinorUnits; project: MinorUnits; common: MinorUnits; direct: MinorUnits; total: MinorUnits }
	npv: MinorUnits
	firstRevenueMonth: number | null
	cashBeforeFirstRevenue: MinorUnits
	peakFunding: { amount: MinorUnits; month: number | null }
}

/**
 * Recalculates the economics of `selection` through `prepareScenario` and `projectCashFlow`.
 *
 * A selected building without a plan in the scenario, or with an unresolved unit total,
 * throws in `@mailwoman/route-scenarios`, and no figure is computed for the selection.
 */
export function selectionEconomics(
	dossier: Dossier,
	scenario: Scenario,
	selection: readonly EntityID[]
): SelectionEconomics {
	const prepared = prepareScenario(dossier, { ...scenario, selected: selection })
	const table = projectCashFlow(prepared)
	const { construction } = table

	return {
		scenario: scenario.id,
		selection,
		currency: scenario.currency,
		origin: scenario.origin,
		synthetic: scenario.origin === "synthetic",
		eligible: prepared.eligible,
		units: prepared.eligible.reduce((sum, entry) => sum + entry.units, 0),
		segments: construction.segments.map((entry) => ({
			segment: entry.segment.id,
			usedBy: entry.usedBy,
			amount: entry.amount,
		})),
		construction: {
			route: construction.route,
			project: construction.projectTotal,
			common: construction.common,
			direct: construction.direct,
			total: construction.total,
		},
		npv: table.npv,
		firstRevenueMonth: table.firstRevenueMonth,
		cashBeforeFirstRevenue: table.cashBeforeFirstRevenue,
		peakFunding: table.peakFunding,
	}
}

/**
 * A selection of buildings that a portfolio funds as one project.
 */
export interface Project {
	id: string
	buildings: readonly EntityID[]
}

/**
 * Two projects of a portfolio and what they share.
 */
export interface ProjectOverlap {
	projects: readonly [string, string]
	buildings: readonly EntityID[]
	segments: readonly string[]
}

function overlapText(overlap: ProjectOverlap): string {
	const segments = overlap.segments.length
		? [`${overlap.segments.length === 1 ? "segment" : "segments"} ${proseList(overlap.segments)}`]
		: []

	return `projects ${overlap.projects[0]} and ${overlap.projects[1]} share ${proseList([...overlap.buildings, ...segments])}`
}

/**
 * A portfolio whose projects share a building or a segment.
 */
export class OverlappingProjectsError extends Error {
	readonly overlaps: readonly ProjectOverlap[]

	constructor(overlaps: readonly ProjectOverlap[]) {
		super(
			`${overlaps.map(overlapText).join(". ")}. A portfolio total counts only projects that share no building and no segment`
		)

		this.name = "OverlappingProjectsError"
		this.overlaps = overlaps
	}
}

export interface PortfolioTotals {
	scenario: string
	currency: string
	synthetic: boolean
	projects: readonly (SelectionEconomics & { project: string })[]
	/**
	 * The sum of the projects' eligible units.
	 */
	units: number
	/**
	 * The sum of the projects' construction costs.
	 */
	construction: MinorUnits
	/**
	 * The sum of the projects' NPVs, each discounted under the scenario's one set of conventions.
	 */
	npv: MinorUnits
}

/**
 * Every pair of projects that shares a building or a segment.
 *
 * A project's segments are the routes its buildings' plans name.
 */
function projectOverlaps(scenario: Scenario, projects: readonly Project[]): ProjectOverlap[] {
	const segmentsOf = (project: Project) =>
		new Set(project.buildings.flatMap((building) => buildingPlan(scenario, building).route))

	const overlaps: ProjectOverlap[] = []

	for (const [index, first] of projects.entries()) {
		for (const second of projects.slice(index + 1)) {
			const buildings = first.buildings.filter((building) => second.buildings.includes(building))
			const theirs = segmentsOf(second)
			const segments = [...segmentsOf(first)].filter((segment) => theirs.has(segment))

			if (buildings.length || segments.length) {
				overlaps.push({ projects: [first.id, second.id], buildings, segments })
			}
		}
	}

	return overlaps
}

/**
 * The totals of a portfolio of projects drawn from one scenario.
 *
 * Throws {@link OverlappingProjectsError} when two projects share a building or a segment,
 * and {@link MapInputError} for an empty portfolio or a project identifier used twice.
 */
export function portfolioTotals(dossier: Dossier, scenario: Scenario, projects: readonly Project[]): PortfolioTotals {
	if (!projects.length) throw new MapInputError("projects", "the portfolio holds no project")

	const ids = new Set<string>()

	for (const [index, project] of projects.entries()) {
		if (ids.has(project.id)) {
			throw new MapInputError(`projects[${index}].id`, `the project identifier ${project.id} appears twice`)
		}

		ids.add(project.id)
	}

	const overlaps = projectOverlaps(scenario, projects)

	if (overlaps.length) throw new OverlappingProjectsError(overlaps)

	const results = projects.map((project) => ({
		project: project.id,
		...selectionEconomics(dossier, scenario, project.buildings),
	}))

	return {
		scenario: scenario.id,
		currency: scenario.currency,
		synthetic: scenario.origin === "synthetic",
		projects: results,
		units: results.reduce((sum, entry) => sum + entry.units, 0),
		construction: results.reduce((sum, entry) => sum + entry.construction.total, 0),
		npv: results.reduce((sum, entry) => sum + entry.npv, 0),
	}
}
