/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The abstention-threshold curve over the frozen same-data results (#2264): what an arm would score if it
 *   withheld every selection whose recorded confidence fell below a threshold.
 *
 *   This re-grades committed results; it does not re-run a resolver, so it holds the WALK fixed. A resolver
 *   that actually refused a node could ask different questions afterwards, through `parentFallback` and
 *   `hierarchyCompletion`, and reach a different final selection. The curve is an upper bound on what a
 *   threshold over this confidence signal can provide at the final selection, not a prediction of what the
 *   shipped knob would do.
 *
 *   The signal it thresholds is the arm's own margin — the winner's lead over the runner-up within the set
 *   that arm considered — so a lookup that considered one candidate reports 1 and no threshold at or below 1
 *   can withhold it. That ceiling is the result worth reading, not a limitation of the sweep.
 *
 *   A withheld row is re-graded into the same {@link ArmRowResult} shape and scored by `armMetrics`, so the
 *   curve and the benchmark's own tables count accuracy, wrong-area and false selection through one function.
 */

import type { ArmRowResult } from "#eval-harness/same-data/arms"
import type { SameDataPanelRow } from "#eval-harness/same-data/fixture"
import {
	armMetrics,
	type ArmMetrics,
	type BenchmarkVerdict,
	comparePaired,
	evaluateVerdict,
} from "#eval-harness/same-data/score"

/**
 * The thresholds the sweep reports. Dense below 0.5 because the recorded margins pile up near zero, and inclusive of 1
 * so the single-candidate ceiling is printed rather than inferred.
 */
export const THRESHOLD_STEPS = [
	0, 0.01, 0.05, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.99, 1,
] as const satisfies readonly number[]

/**
 * Re-grade one arm's results as if it had withheld every selection under `threshold`.
 *
 * A withheld row becomes an abstention rather than a wrong answer: `correct` false, no distance, and a mechanism that
 * names the threshold. An errored row passes through untouched — a harness failure is not a selection and the scorer
 * excludes it either way.
 */
export function applyThreshold(results: readonly ArmRowResult[], threshold: number): ArmRowResult[] {
	return results.map((result) => {
		if (result.error || result.selection === null || result.confidence >= threshold) return result

		return {
			...result,
			selection: null,
			correct: false,
			wrongArea: null,
			distanceKm: null,
			mechanism: `withheld:below_threshold ${result.mechanism ?? "none"}`,
		}
	})
}

export interface ThresholdPoint {
	threshold: number
	/**
	 * Selections this threshold withheld — the abstentions it adds to the arm's own.
	 */
	withheld: number
	metrics: ArmMetrics
}

/**
 * One arm's curve over `thresholds`.
 */
export function thresholdCurve(
	arm: string,
	results: readonly ArmRowResult[],
	panelByID: ReadonlyMap<string, SameDataPanelRow>,
	thresholds: readonly number[] = THRESHOLD_STEPS
): ThresholdPoint[] {
	return thresholds.map((threshold) => {
		const regraded = applyThreshold(results, threshold)

		return {
			threshold,
			withheld: regraded.filter((result, index) => result.selection === null && results[index]!.selection !== null)
				.length,
			metrics: armMetrics(arm, `threshold:${threshold}`, panelByID, regraded),
		}
	})
}

/**
 * The withheld-gold selections no threshold at or below 1 can withhold, because the lookup that produced them
 * considered a single candidate and so reported the maximum margin.
 */
export function irreducibleFalseSelections(
	results: readonly ArmRowResult[],
	panelByID: ReadonlyMap<string, SameDataPanelRow>
): { count: number; of: number } {
	const goldAbsent = results.filter(
		(result) => !result.error && panelByID.get(result.rowID)?.goldPresent === false && result.selection !== null
	)

	return { count: goldAbsent.filter((result) => result.confidence >= 1).length, of: goldAbsent.length }
}

/**
 * The thresholds that beat a reference arm on both axes at once — selection accuracy at or above its accuracy,
 * false-selection rate at or below its rate. Empty when the trade cannot be won on both.
 *
 * Both axes together, because either one alone is trivially winnable: threshold 0 maximizes accuracy and threshold 1
 * minimizes false selection, and each is the other's worst case.
 */
export function dominatingPoints(
	curve: readonly ThresholdPoint[],
	reference: { selectionAccuracy: number; falseSelectionRate: number }
): ThresholdPoint[] {
	return curve.filter(
		(point) =>
			(point.metrics.selectionAccuracy.value ?? 0) >= reference.selectionAccuracy &&
			(point.metrics.falseSelection.value ?? 1) <= reference.falseSelectionRate
	)
}

export interface ThresholdDecision {
	threshold: number
	verdict: BenchmarkVerdict
}

/**
 * The registered decision rule, re-read at each of `thresholds` against an unthresholded reference arm.
 *
 * It runs through the same `comparePaired` and `evaluateVerdict` the frozen decision used, so a difference here is the
 * threshold and nothing else. It is exploratory by construction: a threshold read off visible results is the
 * pre-registration moving, which is what the rule exists to prevent.
 */
export function thresholdDecisions(
	results: readonly ArmRowResult[],
	reference: readonly ArmRowResult[],
	panelByID: ReadonlyMap<string, SameDataPanelRow>,
	thresholds: readonly number[],
	options: { bootstrap: { resamples: number; seed: number }; requiredMarginPoints: number }
): ThresholdDecision[] {
	const strata = [...new Set([...panelByID.values()].map((row) => row.stratum))]

	return thresholds.map((threshold) => {
		const regraded = applyThreshold(results, threshold)

		const scopedTo = (rows: readonly ArmRowResult[], stratum: string) =>
			rows.filter((result) => result.stratum === stratum)

		const byStratum = new Map(
			strata.map((stratum) => [
				stratum,
				{
					mailwoman: armMetrics("mailwoman", stratum, panelByID, scopedTo(regraded, stratum)),
					baseline: armMetrics("baseline", stratum, panelByID, scopedTo(reference, stratum)),
				},
			])
		)

		return {
			threshold,
			verdict: evaluateVerdict(
				comparePaired(regraded, reference, panelByID, options.bootstrap),
				byStratum,
				options.requiredMarginPoints
			),
		}
	})
}
