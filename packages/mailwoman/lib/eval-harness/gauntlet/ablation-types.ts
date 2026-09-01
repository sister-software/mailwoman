/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The ablation layer's DATA SHAPES — the deletion map's cell, its per-row record, and the vocabulary they are keyed
 *   by. Their own module because three files need them (the runner, the renderer, the tests) and a shape shared by a
 *   producer and a consumer that also import each other is an import cycle waiting to be discovered by a linter.
 *
 *   `AblationCell`'s first eleven fields are specified by the suggestion layer's design doc
 *   (`docs/superpowers/plans/2026-08-05-suggestion-layer.md` §C.5) and are owed exactly; everything after them is marked
 *   ADDITIVE and says why it exists.
 */

import { percentile } from "@mailwoman/core/stats"
import type { ComponentTag } from "@mailwoman/core/types"

import { ABLATION_GRADES, type AblationGrade, emptyGrades } from "#eval-harness/gauntlet/ablation-expectation"
import type { ResolutionTier } from "#eval-harness/gauntlet/schema"

/**
 * The component classes this runner deletes — every tag the curated corpus actually asserts, and every one
 * {@linkcode componentOf} can read back off the assembled result (the slot a substitution would land in). A tag with no
 * result field could be deleted but not scored for substitution, which is half a measurement; adding one means adding
 * the field to `GauntletResult` first.
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
 * Fallback displacement band, in km, for a row that asserts no `expect_tolerance_m`. Rows that DO assert one are graded
 * against theirs — a row pinned to an 80 m rooftop and a row pinned to a 500 km "in NY not France" guard are not asking
 * the same question, and one band for both would answer neither. The per-row value used is recorded on every row of the
 * JSON artifact.
 */
export const DEFAULT_ABLATION_TOLERANCE_KM = 5

/**
 * One cell of the deletion-ablation map: what deleting `component` costs in `locale`, on a named board. The suggestion
 * layer reads this as a per-(component, locale) prior on nudge value; §C.5 of its design doc specifies the first eleven
 * fields and this runner owes them exactly. The last three are additive and marked as such — each exists because a
 * specced field is not interpretable without it.
 */
export interface AblationCell {
	component: AblatableComponent
	/**
	 * ISO-3166 alpha-2, matching the board's own `country` column — STATED by the corpus row, never inferred from the
	 * input. (The design doc allows BCP-47 "matching whatever the board keys by"; this board keys by country.)
	 */
	locale: string
	/**
	 * Board rows that CARRY this component in this locale — the denominator behind every rate below. A cell with
	 * `support: 0` means NOT MEASURED HERE, and a consumer must represent that as absence rather than as a zero score
	 * (the meaning-of-zero rule). This runner never EMITS a zero-support cell: a (component, locale) pair with no rows is
	 * absent from the array, and {@linkcode formatAblationCell} renders a missing lookup and a zero-support one
	 * identically.
	 */
	support: number
	/**
	 * Rows whose assembled coordinate moved further than the row's tolerance once the component was deleted. A row whose
	 * ablated arm produced NO coordinate counts as broken too — losing the answer is not a small displacement.
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
	 * Rows where the deleted component's SLOT was refilled by a DIFFERENT span — S-2's finding 3 (a house number emitted
	 * as the postcode). Distinct from `brokenCount`: a refill can leave the coordinate intact and still make a completion
	 * nudge unsafe, because the slot the nudge wanted to fill reads as already filled.
	 */
	substitutedCount: number
	/**
	 * The fallback band ({@linkcode DEFAULT_ABLATION_TOLERANCE_KM}); a row asserting its own `expect_tolerance_m` was
	 * graded against that instead. Per-row values are in the artifact's `rows`.
	 */
	toleranceKm: number
	/**
	 * Which board this was measured on, and when. A cell without both is not a measurement.
	 */
	boardID: string
	measuredAt: string
	/**
	 * ADDITIVE (not in §C.5): rows where the ablated arm re-emitted the SAME value the deletion removed — the resolver
	 * recovered it from the gazetteer. Without this, `substitutedCount` would have to mean "refilled by anything" and a
	 * recovery would read as a hazard. 0 of 139 on S-2's postcode column, which is itself the finding.
	 */
	recoveredCount: number
	/**
	 * ADDITIVE: rows excluded from the displacement percentiles because the row's OWN anchor never resolved. Not a
	 * failure of the deletion — there was nothing to measure against. Named so `gradedCount < support` is attributable.
	 */
	anchorUnresolvedCount: number
	/**
	 * ADDITIVE: rows where BOTH arms resolved — the denominator of `displacementKmP50` / `P90`.
	 */
	gradedCount: number
	/**
	 * ADDITIVE (the 2026-08-05 expectation model): rows this cell could grade against a DEGRADATION LADDER — the
	 * denominator of every `grades` count below. `0` means the expectation model never spoke here (no gazetteer, or the
	 * anchor resolved no gazetteer place), and a consumer must render that as ABSENCE exactly as it does `support: 0` —
	 * {@linkcode formatAblationLadderCell} is the enforcement.
	 */
	ladderGradedCount: number
	/**
	 * ADDITIVE: the full verdict histogram, keyed by {@linkcode AblationGrade}. Every key is present so a reader never has
	 * to tell "no rows in this class" from "this runner does not emit that class" — within a cell that already has
	 * `ladderGradedCount > 0`, a zero IS a measurement.
	 */
	grades: Record<AblationGrade, number>
	/**
	 * ADDITIVE: the headline three. `trueFailCount` is everything {@linkcode PASSING_GRADES} does not cover — the number
	 * that replaces `brokenCount` as the operator's "what is actually wrong here".
	 */
	trueFailCount: number
	correctlyDegradedCount: number
	/**
	 * ADDITIVE: the honest half of the old `unresolvedCount`. Its complement is `grades.lost`.
	 */
	correctlyAbstainedCount: number
	/**
	 * ADDITIVE: how far down the ladder the passing rows landed (0 = held at the base). `null` when no row in this cell
	 * was graded against a ladder — never 0, which would read as "nothing degraded".
	 */
	degradedRungsP50: number | null
	degradedRungsMax: number | null
	/**
	 * ADDITIVE: rows where the model DECLINED to constrain the answer because a venue or street survived the deletion and
	 * it has no index for either ({@linkcode UNCONSTRAINED_RUNG}). Those rows still fail on leaving the ladder, but their
	 * passes are weaker evidence than the rest of the cell's — a cell whose `ladderGradedCount` is mostly this is a cell
	 * to read with suspicion, and the only way to know that is for the count to be here.
	 */
	unconstrainedCount: number
}

/**
 * One row × one deleted component: the per-case record behind a cell. Written to the artifact so any cell number can be
 * traced back to the inputs that produced it.
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
	 * `null` when the anchor never resolved — "not gradable", which is not the same as "held".
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
	 * ADDITIVE (the expectation model). `expectedRung` is `abstain`, `base`, or the WOF placetype of the rung the
	 * SURVIVING components still pin; `expectedWhy` is the derivation in one sentence, so any verdict can be argued with
	 * from the artifact alone.
	 */
	expectedRung: string
	expectedRungDepth: number | null
	expectedWhy: string
	/**
	 * Where the expectation came from: the derived ladder, a per-case `ablation_expect` pin, or nothing (no ladder).
	 */
	expectedSource: "derived" | "override" | "no-ladder"
	/**
	 * What rung 0 of the ladder IS: the corpus's asserted coordinate, or (weaker) the pipeline's undeleted answer for a
	 * row that asserts none. `null` when there is no ladder. A verdict read without this can't tell a claim graded
	 * against the corpus from one graded against the parser's own opinion.
	 */
	ladderAnchor: "corpus-expected" | "pipeline-anchor" | null
	/**
	 * The rung the UNDELETED answer reached — the floor this variant was judged from. `null` = the anchor is off its own
	 * ladder, which makes the row `ungraded`.
	 */
	anchorRungDepth: number | null
	/**
	 * The deepest rung the ablated answer actually landed in, and its depth — `null` when it abstained, or when it landed
	 * outside every rung (which is `grade: "wrong"`, not depth 0).
	 */
	achievedRung: string | null
	achievedRungDepth: number | null
	/**
	 * How many rungs the answer fell (0 = held at the base). The rung-depth delta, as data.
	 */
	degradedRungs: number | null
	grade: AblationGrade
	/**
	 * The ladder this row was graded against, one entry per rung (`locality Las Vegas ±6.0km`), plus the rungs the
	 * ancestry could not support. Written per row because a verdict without its ladder is not re-checkable.
	 */
	ladder: string[]
	ladderGaps: string[]
}

/**
 * What happened to the deleted component's slot in the ablated arm.
 */
export type SlotOutcome = "absent" | "recovered" | "substituted"

/**
 * A component the row asserts but this runner refused to delete, and why. Reported per reason so a thin cell is
 * attributable to the corpus rather than to the pipeline — "we could not measure it" and "it did not matter" must never
 * look the same.
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
 * One component's roll-up across every locale — the shared source for the console summary and the markdown report,
 * which had drifted apart by re-deriving these sums independently.
 *
 * Sums come from the CELLS; the displacement percentiles come from the pooled ROWS, because percentiles do not
 * aggregate — a global p90 has to be taken over the pooled displacements, never over the per-cell p90s.
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
 * Aggregate the deletion map per component, in {@linkcode ABLATABLE_COMPONENTS} order, omitting components with no cell
 * — a component nobody measured must never render as a row of zeros.
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
