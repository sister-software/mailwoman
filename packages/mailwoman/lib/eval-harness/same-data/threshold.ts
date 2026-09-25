/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Computes the abstention-threshold curve over frozen same-data results.
 *
 *   The curve shows what an arm would score if it withheld every selection whose recorded confidence fell
 *   below a threshold. It re-grades committed results without re-running the resolver. A resolver that
 *   refused a node could reach a different selection through `parentFallback` or `hierarchyCompletion`,
 *   so the curve estimates the effect of a threshold without predicting a shipped option.
 *
 *   The confidence is the winner's margin over the runner-up. A lookup with one candidate reports 1, so
 *   no threshold at or below 1 withholds it.
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
 * The thresholds the sweep reports.
 *
 * The steps are dense near zero, where most recorded margins fall.
 * The list includes 1 so the report shows the single-candidate ceiling.
 */
export const THRESHOLD_STEPS = [
	0, 0.01, 0.05, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.99, 1,
] as const satisfies readonly number[]

/**
 * Re-grades one arm's results as if it had withheld every selection with confidence below `threshold`.
 *
 * A withheld row becomes an abstention with `correct` false, null distance fields,
 * and a mechanism prefixed with `withheld:below_threshold`.
 * Errored rows are returned unchanged.
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

/**
 * One point on an arm's threshold curve.
 */
export interface ThresholdPoint {
	threshold: number
	/**
	 * The number of selections this threshold withheld, beyond the arm's own abstentions.
	 */
	withheld: number
	metrics: ArmMetrics
}

/**
 * Computes one arm's curve over `thresholds`.
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
 * Counts the selections on withheld-gold rows that report confidence 1, out of all such selections.
 *
 * No threshold at or below 1 can withhold these selections.
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
 * Returns the curve points that match or beat a reference arm on both selection
 * accuracy and false-selection rate.
 *
 * The filter requires both because either one alone is easy to win.
 * Threshold 0 maximizes accuracy, and threshold 1 minimizes false selection.
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

/**
 * The decision rule's verdict at one threshold.
 */
export interface ThresholdDecision {
	threshold: number
	verdict: BenchmarkVerdict
}

/**
 * Evaluates the registered decision rule at each threshold against an unthresholded reference arm.
 *
 * It uses the same `comparePaired` and `evaluateVerdict` as the frozen decision.
 * The results are exploratory, because choosing a threshold after seeing results
 * would break the pre-registration.
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
