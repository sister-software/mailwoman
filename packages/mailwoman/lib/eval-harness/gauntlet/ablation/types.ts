/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { ResolutionTier } from "@mailwoman/annotations/geo"
import type { ComponentTag } from "@mailwoman/codex/component"
import { percentile } from "@mailwoman/core/stats"

import { ABLATION_GRADES, type AblationGrade, emptyGrades } from "#eval-harness/gauntlet/ablation/expectation"

/**
 * The component classes this runner deletes; adding one means adding the field to `GauntletResult` first.
 */
export const ABLATABLE_COMPONENTS = [
	"postcode",
	"house_number",
	"street",
	"locality",
	"dependent_locality",
	"region",
	"country",
	"unit",
	"venue",
] as const satisfies readonly ComponentTag[]

export type AblatableComponent = (typeof ABLATABLE_COMPONENTS)[number]

/**
 * Fallback displacement band, in km, for a row that asserts no `expect_tolerance_m` — rows that do assert one are graded against theirs.
 */
export const DEFAULT_ABLATION_TOLERANCE_KM = 5

/**
 * One cell of the deletion-ablation map: what deleting `component` costs in `locale`, on a named board.
 */
export interface AblationCell {
	component: AblatableComponent
	/**
	 * ISO-3166 alpha-2, matching the board's own `country` column — stated by the corpus row, never inferred from the input.
	 */
	locale: string
	/**
	 * Board rows that carry this component in this locale; `support: 0` means not measured here, not a zero score.
	 */
	support: number
	/**
	 * Rows whose assembled coordinate moved further than the row's tolerance once the component was deleted; a row whose ablated arm produced no coordinate counts as broken.
	 */
	brokenCount: number
	displacementKmP50: number
	displacementKmP90: number
	/**
	 * Rows whose `resolution_tier` coarsened (address_point → interpolated → street → admin).
	 */
	tierDropCount: number
	/**
	 * Rows that produced no coordinate at all without the component.
	 */
	unresolvedCount: number
	/**
	 * Rows where the deleted component's slot was refilled by a different span; a refill can leave the coordinate intact and still make a completion nudge unsafe.
	 */
	substitutedCount: number
	/**
	 * The fallback band ({@linkcode DEFAULT_ABLATION_TOLERANCE_KM}); a row asserting its own `expect_tolerance_m` was graded against that instead.
	 */
	toleranceKm: number
	/**
	 * Which board this was measured on, and when; a cell without both is not a measurement.
	 */
	boardID: string
	measuredAt: string
	/**
	 * Rows where the ablated arm re-emitted the same value the deletion removed — the resolver recovered it from the gazetteer.
	 */
	recoveredCount: number
	/**
	 * Rows excluded from the displacement percentiles because the row's own anchor never resolved; not a failure of the deletion.
	 */
	anchorUnresolvedCount: number
	/**
	 * Rows where both arms resolved — the denominator of `displacementKmP50` / `P90`.
	 */
	gradedCount: number
	/**
	 * Rows this cell could grade against a degradation ladder, the denominator of every `grades` count; `0` means the expectation model never spoke here.
	 */
	ladderGradedCount: number
	/**
	 * The full verdict histogram, keyed by {@linkcode AblationGrade}; every key is present so a zero within a graded cell is a measurement.
	 */
	grades: Record<AblationGrade, number>
	/**
	 * Everything {@linkcode PASSING_GRADES} does not cover.
	 */
	trueFailCount: number
	correctlyDegradedCount: number
	/**
	 * Its complement is `grades.lost`.
	 */
	correctlyAbstainedCount: number
	/**
	 * How far down the ladder the passing rows landed (0 = held at the base); `null` when no row in this cell was graded, never 0.
	 */
	degradedRungsP50: number | null
	degradedRungsMax: number | null
	/**
	 * Rows where the model declined to constrain the answer because a venue or street survived the deletion and it has no index for either ({@linkcode UNCONSTRAINED_RUNG}).
	 */
	unconstrainedCount: number
}

/**
 * One row × one deleted component: the per-case record behind a cell.
 */
export interface AblationRowOutcome {
	caseID: string
	component: AblatableComponent
	locale: string
	status: string
	/**
	 * The exact substring removed, as it appeared in the input (not as asserted — the search is case-insensitive).
	 */
	deleted: string
	anchorInput: string
	ablatedInput: string
	anchorLat: number | null
	anchorLon: number | null
	anchorTier: ResolutionTier
	ablatedLat: number | null
	ablatedLon: number | null
	ablatedTier: ResolutionTier
	displacementKm: number | null
	toleranceKm: number
	/**
	 * `null` when the anchor never resolved — 'not gradable', which is not the same as 'held'.
	 */
	broken: boolean | null
	tierDrop: boolean
	unresolved: boolean
	slot: SlotOutcome
	/**
	 * What the ablated arm put in the deleted component's slot (`null` = left empty).
	 */
	emitted: string | null
	/**
	 * `expectedRung` is `abstain`, `base`, or the WOF placetype of the rung the surviving components still pin; `expectedWhy` is the derivation.
	 */
	expectedRung: string
	expectedRungDepth: number | null
	expectedWhy: string
	/**
	 * Where the expectation came from: the derived ladder, a per-case `ablation_expect` pin, or no expectation (no ladder).
	 */
	expectedSource: "derived" | "override" | "no-ladder"
	/**
	 * What rung 0 of the ladder is: the corpus's asserted coordinate, or the pipeline's undeleted answer for a row that asserts none; `null` when there is no ladder.
	 */
	ladderAnchor: "corpus-expected" | "pipeline-anchor" | null
	/**
	 * The rung the undeleted answer reached; `null` means the anchor is off its own ladder, which makes the row `ungraded`.
	 */
	anchorRungDepth: number | null
	/**
	 * The deepest rung the ablated answer actually landed in, and its depth; `null` when it abstained or landed outside every rung.
	 */
	achievedRung: string | null
	achievedRungDepth: number | null
	/**
	 * How many rungs the answer fell (0 = held at the base).
	 */
	degradedRungs: number | null
	grade: AblationGrade
	/**
	 * The ladder this row was graded against, one entry per rung, plus the rungs the ancestry could not support.
	 */
	ladder: string[]
	ladderGaps: string[]
}

/**
 * What happened to the deleted component's slot in the ablated arm.
 */
export type SlotOutcome = "absent" | "recovered" | "substituted"

/**
 * A component the row asserts but this runner refused to delete, reported per reason so a thin cell is attributable to the corpus rather than to the pipeline.
 */
export interface AblationSkip {
	component: AblatableComponent
	value: string
	reason: string
}

/**
 * A deletion variant: the ablated input plus the exact span removed.
 */
export interface AblationVariant {
	component: AblatableComponent
	deleted: string
	input: string
}

/**
 * One component's roll-up across every locale; a global p90 is taken over the pooled displacements, never over the per-cell p90s.
 */
export interface AblationComponentAggregate {
	component: AblatableComponent
	support: number
	brokenCount: number
	displacementKmP50: number | null
	displacementKmP90: number | null
	tierDropCount: number
	unresolvedCount: number
	substitutedCount: number
	ladderGradedCount: number
	trueFailCount: number
	grades: Record<AblationGrade, number>
	unconstrainedCount: number
}

/**
 * Aggregate the deletion map per component, in {@linkcode ABLATABLE_COMPONENTS} order, omitting components with no cell so an unmeasured component never renders as a row of zeros.
 */
export function aggregateAblationComponents(
	cells: readonly AblationCell[],
	rows: readonly AblationRowOutcome[]
): AblationComponentAggregate[] {
	const aggregates: AblationComponentAggregate[] = []

	for (const component of ABLATABLE_COMPONENTS) {
		const own = cells.filter((cell) => cell.component === component)

		if (!own.length) continue

		const pooled = rows
			.filter((row) => row.component === component && row.displacementKm != null)
			.map((row) => row.displacementKm!)

		const sum = (pick: (cell: AblationCell) => number): number => own.reduce((total, cell) => total + pick(cell), 0)
		const grades = emptyGrades()

		for (const cell of own) {
			for (const grade of ABLATION_GRADES) {
				grades[grade] += cell.grades[grade]
			}
		}

		aggregates.push({
			component,
			support: sum((cell) => cell.support),
			brokenCount: sum((cell) => cell.brokenCount),
			displacementKmP50: percentile(pooled, 50),
			displacementKmP90: percentile(pooled, 90),
			tierDropCount: sum((cell) => cell.tierDropCount),
			unresolvedCount: sum((cell) => cell.unresolvedCount),
			substitutedCount: sum((cell) => cell.substitutedCount),
			ladderGradedCount: sum((cell) => cell.ladderGradedCount),
			trueFailCount: sum((cell) => cell.trueFailCount),
			grades,
			unconstrainedCount: sum((cell) => cell.unconstrainedCount),
		})
	}

	return aggregates
}
