/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The scorer for the same-data benchmark (#2261): the registered metrics per stratum and pooled, the
 *   exact McNemar decision, and the paired bootstrap interval.
 *
 *   The test is paired because the design is: every arm answers the same rows from the same evidence, so the
 *   informative quantity is the discordant pairs — rows one arm got right and the other did not. An unpaired
 *   proportion test would discard that pairing and widen the interval for nothing.
 *
 *   The decision is pooled and the per-stratum tables are descriptive. Exact power at alpha 0.05 two-sided:
 *   100 rows gives 0.74 against a true 12-point margin and 0.90 against 18 points. 50 rows gives 0.36 and
 *   0.58. Five per-stratum significance decisions at that power are five chances to find a win, so the power
 *   is spent once, pooled, at the registered 8-point margin.
 *
 *   A row whose arm raised is excluded from every metric and counted separately. Folding it into abstention
 *   would let a harness failure read as a resolver refusing, which is what the abstention strata measure.
 */

import { mulberry32 } from "@mailwoman/core/random"
import { percentileSorted } from "@mailwoman/core/stats"

import type { ArmRowResult } from "#eval-harness/same-data/arms"
import type { SameDataPanelRow } from "#eval-harness/same-data/fixture"

/**
 * The registered confidence bins for the reliability table, low edge inclusive and high edge exclusive except the last.
 */
export const CONFIDENCE_BINS = [0, 0.2, 0.4, 0.6, 0.8, 1] as const

/**
 * The largest discordant-pair count the exact test computes. The first term is `2 ** -n`, which is representable down
 * to about n = 1074. the bound is well inside that and refusing past it beats returning a silent zero.
 */
const MAX_EXACT_N = 1000

/**
 * The registered two-sided significance level. Frozen with the rest of the decision rule, because a level chosen after
 * a p-value is visible is the decision rule moving.
 */
export const SIGNIFICANCE_ALPHA = 0.05

/**
 * The two-sided exact McNemar p-value for `b` rows the first arm won and `c` rows the second won.
 *
 * Computed as a two-sided exact binomial test at p = 0.5 over the discordant pairs. The terms are built by the ratio
 * `C(n, i+1) = C(n, i) * (n - i) / (i + 1)` starting from `2 ** -n`, so no factorial is formed and nothing overflows.
 */
export function mcnemarExactP(b: number, c: number): number {
	const n = b + c

	if (n === 0) return 1

	if (n > MAX_EXACT_N) {
		throw new Error(`same-data scorer: ${n} discordant pairs exceeds the exact test's bound of ${MAX_EXACT_N}`)
	}

	const k = Math.min(b, c)
	let term = 2 ** -n
	let tail = term

	for (let i = 0; i < k; i++) {
		term = (term * (n - i)) / (i + 1)
		tail += term
	}

	return Math.min(1, 2 * tail)
}

/**
 * A rate together with the two counts that produced it.
 *
 * The counts travel with the value because a renderer that is handed only the rate has to recover the numerator by
 * multiplying, and it can only multiply by the denominator it happens to hold. Pooled selection accuracy is measured
 * over the gold-present rows while the table's `n` column counts every scored row, so that reconstruction printed a
 * numerator no arm ever produced beside a rate that was correct.
 */
export interface Ratio {
	numerator: number
	denominator: number
	/**
	 * Null when the denominator is zero — an unmeasured rate, never zero.
	 */
	value: number | null
}

function ratio(numerator: number, denominator: number): Ratio {
	return { numerator, denominator, value: denominator === 0 ? null : numerator / denominator }
}

/**
 * One arm's counts within one denominator.
 */
export interface ArmMetrics {
	arm: string
	stratum: string
	/**
	 * Rows scored — after errored rows are removed. This is the row count rather than the denominator of any rate below.
	 * each rate carries its own.
	 */
	n: number
	errors: number
	selections: number
	abstentions: number
	/**
	 * Correct over the rows whose gold is present. Unmeasured in the withheld-gold stratum, which has no correct answer
	 * by construction.
	 */
	selectionAccuracy: Ratio
	/**
	 * Wrong-area selections over the selections that carried a coordinate.
	 */
	wrongArea: Ratio
	/**
	 * Both measured over the withheld-gold rows, so both are unmeasured everywhere else.
	 */
	abstentionPrecision: Ratio
	falseSelection: Ratio
	mechanismCoverage: Ratio
}

/**
 * One arm's metrics over one row set.
 */
export function armMetrics(
	arm: string,
	stratum: string,
	panelByID: ReadonlyMap<string, SameDataPanelRow>,
	results: readonly ArmRowResult[]
): ArmMetrics {
	const errors = results.filter((result) => result.error).length
	const scored = results.filter((result) => !result.error)
	const goldPresent = scored.filter((result) => panelByID.get(result.rowID)?.goldPresent !== false)
	const goldAbsent = scored.filter((result) => panelByID.get(result.rowID)?.goldPresent === false)
	const selections = scored.filter((result) => result.selection !== null)
	const abstentions = scored.length - selections.length
	const measuredArea = goldPresent.filter((result) => result.wrongArea !== null)

	return {
		arm,
		stratum,
		n: scored.length,
		errors,
		selections: selections.length,
		abstentions,
		selectionAccuracy: ratio(goldPresent.filter((result) => result.correct).length, goldPresent.length),
		wrongArea: ratio(measuredArea.filter((result) => result.wrongArea === true).length, measuredArea.length),
		abstentionPrecision: ratio(goldAbsent.filter((result) => result.selection === null).length, goldAbsent.length),
		falseSelection: ratio(goldAbsent.filter((result) => result.selection !== null).length, goldAbsent.length),
		mechanismCoverage: ratio(scored.filter((result) => result.mechanism !== null).length, scored.length),
	}
}

/**
 * One reliability bin.
 */
export interface ReliabilityBin {
	low: number
	high: number
	count: number
	accuracy: number | null
}

/**
 * The reliability table over one arm's non-abstained selections.
 */
export function reliabilityTable(results: readonly ArmRowResult[]): ReliabilityBin[] {
	const selections = results.filter((result) => !result.error && result.selection !== null)

	return CONFIDENCE_BINS.slice(0, -1).map((low, index) => {
		const high = CONFIDENCE_BINS[index + 1]!
		const isLast = index === CONFIDENCE_BINS.length - 2

		const inBin = selections.filter(
			(result) => result.confidence >= low && (isLast ? result.confidence <= high : result.confidence < high)
		)

		return {
			low,
			high,
			count: inBin.length,
			accuracy: ratio(inBin.filter((result) => result.correct).length, inBin.length).value,
		}
	})
}

/**
 * The paired comparison of two arms over the rows both scored.
 */
export interface PairedComparison {
	/**
	 * Rows both arms scored without error and whose gold is present.
	 */
	n: number
	/**
	 * Rows the first arm got right and the second did not.
	 */
	firstOnly: number
	/**
	 * Rows the second arm got right and the first did not.
	 */
	secondOnly: number
	bothCorrect: number
	neitherCorrect: number
	/**
	 * The first arm's accuracy minus the second's, in proportion points.
	 */
	difference: number
	pValue: number
	/**
	 * The 95 percent paired-bootstrap interval on {@link PairedComparison.difference}.
	 */
	intervalLow: number
	intervalHigh: number
	resamples: number
	seed: number
}

/**
 * Compare two arms over the rows both scored, paired row by row.
 *
 * The bootstrap resamples ROWS rather than arms: a resample draws row indices with replacement and recomputes both
 * arms' accuracy on the same draw, which is what makes the interval a paired one.
 */
export function comparePaired(
	first: readonly ArmRowResult[],
	second: readonly ArmRowResult[],
	panelByID: ReadonlyMap<string, SameDataPanelRow>,
	options: { resamples: number; seed: number }
): PairedComparison {
	const secondByRow = new Map(second.map((result) => [result.rowID, result]))
	const pairs: Array<[boolean, boolean]> = []

	for (const result of first) {
		const other = secondByRow.get(result.rowID)

		if (!other || result.error || other.error) continue

		if (panelByID.get(result.rowID)?.goldPresent === false) continue

		pairs.push([result.correct, other.correct])
	}

	const firstOnly = pairs.filter(([a, b]) => a && !b).length
	const secondOnly = pairs.filter(([a, b]) => !a && b).length
	const bothCorrect = pairs.filter(([a, b]) => a && b).length
	const n = pairs.length
	const difference = n === 0 ? 0 : (firstOnly - secondOnly) / n

	const random = mulberry32(options.seed)
	const differences: number[] = []

	for (let resample = 0; resample < options.resamples; resample++) {
		let firstCorrect = 0
		let secondCorrect = 0

		for (let draw = 0; draw < n; draw++) {
			const pair = pairs[Math.floor(random() * n)]!

			if (pair[0]) {
				firstCorrect++
			}

			if (pair[1]) {
				secondCorrect++
			}
		}

		differences.push(n === 0 ? 0 : (firstCorrect - secondCorrect) / n)
	}

	differences.sort((left, right) => left - right)

	return {
		n,
		firstOnly,
		secondOnly,
		bothCorrect,
		neitherCorrect: n - firstOnly - secondOnly - bothCorrect,
		difference,
		pValue: mcnemarExactP(firstOnly, secondOnly),
		intervalLow: percentileSorted(differences, 2.5) ?? 0,
		intervalHigh: percentileSorted(differences, 97.5) ?? 0,
		resamples: options.resamples,
		seed: options.seed,
	}
}

/**
 * The registered decision, evaluated. Both conditions must hold. each is reported with what it read, so a refusal names
 * the quantity that refused it.
 */
export interface BenchmarkVerdict {
	marginPoints: number
	requiredMarginPoints: number
	marginMet: boolean
	pValue: number
	significanceMet: boolean
	/**
	 * Strata where Mailwoman's wrong-area rate or false-selection rate exceeds the baseline's. Empty means the secondary
	 * condition held.
	 */
	regressions: string[]
	passed: boolean
}

/**
 * Evaluate the frozen decision rule: an 8-point pooled margin and an exact McNemar rejection at alpha 0.05, with no
 * stratum where Mailwoman's wrong-area or false-selection rate is higher than the baseline's.
 */
export function evaluateVerdict(
	pooled: PairedComparison,
	byStratum: ReadonlyMap<string, { mailwoman: ArmMetrics; baseline: ArmMetrics }>,
	requiredMarginPoints: number
): BenchmarkVerdict {
	const marginPoints = pooled.difference * 100
	const regressions: string[] = []

	for (const [stratum, arms] of byStratum) {
		const worseArea =
			arms.mailwoman.wrongArea.value !== null &&
			arms.baseline.wrongArea.value !== null &&
			arms.mailwoman.wrongArea.value > arms.baseline.wrongArea.value

		const worseFalse =
			arms.mailwoman.falseSelection.value !== null &&
			arms.baseline.falseSelection.value !== null &&
			arms.mailwoman.falseSelection.value > arms.baseline.falseSelection.value

		if (worseArea) {
			regressions.push(`${stratum}: wrong-area rate`)
		}

		if (worseFalse) {
			regressions.push(`${stratum}: false-selection rate`)
		}
	}

	const marginMet = marginPoints >= requiredMarginPoints
	const significanceMet = pooled.pValue <= SIGNIFICANCE_ALPHA

	return {
		marginPoints,
		requiredMarginPoints,
		marginMet,
		pValue: pooled.pValue,
		significanceMet,
		regressions,
		passed: marginMet && significanceMet && regressions.length === 0,
	}
}
