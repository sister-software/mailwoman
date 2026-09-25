/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Scores the same-data benchmark with per-stratum and pooled metrics, an exact McNemar test, and a
 *   paired bootstrap interval.
 *
 *   Every arm answers the same rows, so the tests are paired. The decision uses the pooled comparison,
 *   and the per-stratum tables are descriptive.
 *
 *   A row whose arm threw an error is excluded from every metric and counted in `errors`. Counting it as
 *   an abstention would make a harness failure look like a resolver refusal.
 */

import { mulberry32 } from "@mailwoman/core/random"
import { percentileSorted } from "@mailwoman/core/stats"

import type { ArmRowResult } from "#eval-harness/same-data/arms"
import type { SameDataPanelRow } from "#eval-harness/same-data/fixture"

/**
 * The registered confidence bin edges for the reliability table.
 *
 * Each bin includes its low edge and excludes its high edge, except the last bin, which includes both.
 */
export const CONFIDENCE_BINS = [0, 0.2, 0.4, 0.6, 0.8, 1] as const

/**
 * The largest discordant-pair count the exact test computes.
 *
 * The first term is `2 ** -n`, which underflows to zero near n = 1075.
 * The test throws past this bound instead of returning a wrong p-value.
 */
const MAX_EXACT_N = 1000

/**
 * The registered two-sided significance level.
 * It is part of the frozen decision rule.
 */
export const SIGNIFICANCE_ALPHA = 0.05

/**
 * Returns the two-sided exact McNemar p-value for `b` rows the first arm won and `c` rows the second won.
 *
 * The function runs an exact binomial test at p = 0.5 over the discordant pairs.
 * It builds each term from the previous one with `C(n, i+1) = C(n, i) * (n - i) / (i + 1)`,
 * starting from `2 ** -n`, so it never computes a factorial.
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
 * A rate with the numerator and denominator that produced it.
 *
 * Renderers print these counts directly.
 * A rate's denominator often differs from the row count `n`, so the counts
 * cannot be recovered from the rate.
 */
export interface Ratio {
	numerator: number
	denominator: number
	/**
	 * The rate, or null when the denominator is zero.
	 */
	value: number | null
}

function ratio(numerator: number, denominator: number): Ratio {
	return { numerator, denominator, value: denominator === 0 ? null : numerator / denominator }
}

/**
 * One arm's metrics over one stratum or the pooled rows.
 */
export interface ArmMetrics {
	arm: string
	stratum: string
	/**
	 * The number of rows scored, excluding errored rows.
	 * Each rate carries its own denominator.
	 */
	n: number
	errors: number
	selections: number
	abstentions: number
	/**
	 * Correct selections over the rows whose gold is present.
	 * It is unmeasured in the withheld-gold stratum.
	 */
	selectionAccuracy: Ratio
	/**
	 * Wrong-area selections over the gold-present selections that carried a coordinate.
	 */
	wrongArea: Ratio
	/**
	 * Abstention precision and false selection are measured over withheld-gold rows only.
	 */
	abstentionPrecision: Ratio
	falseSelection: Ratio
	mechanismCoverage: Ratio
}

/**
 * Computes one arm's metrics over a set of row results.
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
 * Computes the reliability table over one arm's error-free selections.
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
 * Compares two arms row by row over the gold-present rows that both scored without error.
 *
 * Each bootstrap resample draws row pairs with replacement and recomputes both arms'
 * accuracy on the same draw, which makes the interval paired.
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
 * The evaluated decision rule, with the observed value behind each condition.
 */
export interface BenchmarkVerdict {
	marginPoints: number
	requiredMarginPoints: number
	marginMet: boolean
	pValue: number
	significanceMet: boolean
	/**
	 * Strata where Mailwoman's wrong-area rate or false-selection rate exceeds the baseline's.
	 */
	regressions: string[]
	passed: boolean
}

/**
 * Evaluates the frozen decision rule.
 *
 * The rule passes when the pooled margin reaches `requiredMarginPoints`, the exact McNemar
 * p-value is at most {@link SIGNIFICANCE_ALPHA}, and no stratum shows a higher wrong-area
 * or false-selection rate for Mailwoman than for the baseline.
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
