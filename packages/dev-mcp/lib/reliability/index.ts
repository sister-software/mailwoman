/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Reliability curves compare reported confidence with observed correctness; this module is pure, and surface-specific
 * confidence collection lives in `surfaces.ts`.
 */

/**
 * One graded confidence; `strata` is free-form because each surface knows its own useful splits,
 * and a fixed field list would force every surface to carry the others empty.
 */
export interface Observation {
	confidence: number
	correct: boolean
	strata: Record<string, string>
}

/**
 * One equal-width confidence bin and how it was graded.
 */
export interface ReliabilityBin {
	lower: number
	upper: number
	n: number
	/**
	 * `null` on an empty bin; zero would be a claim about a mean no observation contributed to.
	 */
	mean_confidence: number | null
	accuracy: number | null
	/**
	 * `accuracy - mean_confidence`, signed, because negative is overconfidence
	 * and an unsigned gap cannot tell it from the harmless direction.
	 */
	gap: number | null
}

/**
 * The reliability curve, its calibration errors and its bins.
 */
export interface ReliabilityCurve {
	n: number
	accuracy: number | null
	/**
	 * Expected calibration error, the population-weighted mean absolute gap, or `null` on an
	 * empty sample — 0 there and 0 on a perfect model are the same number and opposite facts.
	 */
	ece: number | null
	/**
	 * Maximum calibration error, the worst single bin unweighted, reported beside ECE
	 * because a rare badly calibrated bin barely moves ECE and dominates MCE.
	 */
	mce: number | null
	bins: ReliabilityBin[]
}

/**
 * What one confidence threshold would admit.
 */
export interface ThresholdRow {
	threshold: number
	admitted: number
	admitted_share: number
	/**
	 * Accuracy among the admitted, or `null` when no row is admitted — reporting 0
	 * there reads as an eval that admits only errors.
	 */
	precision_above: number | null
	errors_admitted: number
	/**
	 * Correct observations the eval turned away; the cost side of the trade,
	 * which a precision column alone hides.
	 */
	correct_below: number
}

/**
 * Equal-width bins over [0, 1], retaining empty bins because a model whose confidences
 * never enter the low bins is itself the finding.
 */
export function reliabilityCurve(sample: readonly Observation[], binCount: number): ReliabilityCurve {
	const bins: Observation[][] = Array.from({ length: binCount }, () => [])

	for (const observation of sample) {
		// `Math.min` rather than a bare floor, because a confidence of exactly 1.0 indexes one past
		// the last bin and dropping it would silently exclude the most-confident observations.
		const index = Math.min(binCount - 1, Math.floor(observation.confidence * binCount))

		bins[index]!.push(observation)
	}

	let ece = 0
	let mce = 0

	const rows = bins.map((bin, index): ReliabilityBin => {
		const lower = index / binCount
		const upper = (index + 1) / binCount

		if (!bin.length) return { lower, upper, n: 0, mean_confidence: null, accuracy: null, gap: null }

		const meanConfidence = bin.reduce((sum, o) => sum + o.confidence, 0) / bin.length
		const accuracy = bin.filter((o) => o.correct).length / bin.length
		const gap = accuracy - meanConfidence

		ece += (bin.length / sample.length) * Math.abs(gap)
		mce = Math.max(mce, Math.abs(gap))

		return { lower, upper, n: bin.length, mean_confidence: meanConfidence, accuracy, gap }
	})

	if (!sample.length) return { n: 0, accuracy: null, ece: null, mce: null, bins: rows }

	return {
		n: sample.length,
		accuracy: sample.filter((o) => o.correct).length / sample.length,
		ece,
		mce,
		bins: rows,
	}
}

/**
 * What a confidence floor at each threshold would actually buy, since a well-calibrated
 * surface can still have no threshold worth setting; both columns of the trade are reported
 * because a precision figure alone hides the correct answers the check throws away.
 */
export function thresholdTable(sample: readonly Observation[], thresholds: readonly number[]): ThresholdRow[] {
	const correctTotal = sample.filter((o) => o.correct).length

	return thresholds.map((threshold) => {
		const above = sample.filter((o) => o.confidence >= threshold)
		const correctAbove = above.filter((o) => o.correct).length

		return {
			threshold,
			admitted: above.length,
			admitted_share: sample.length ? above.length / sample.length : 0,
			precision_above: above.length ? correctAbove / above.length : null,
			errors_admitted: above.length - correctAbove,
			correct_below: correctTotal - correctAbove,
		}
	})
}

/**
 * One expected/predicted confusion among the admitted errors.
 */
export interface ErrorClass {
	expected: string
	predicted: string
	n: number
}

/**
 * The confusions an eval at `threshold` lets through, most frequent first, restricted to
 * admitted errors because their cost is asymmetric; requires `expected` and `predicted` strata,
 * and a surface without them returns no classes, which is absence rather than a clean confusion matrix.
 */
export function errorClasses(sample: readonly Observation[], threshold: number, limit: number): ErrorClass[] {
	const tally = new Map<string, ErrorClass>()

	for (const observation of sample) {
		if (observation.correct || observation.confidence < threshold) continue

		const expected = observation.strata["expected"]
		const predicted = observation.strata["predicted"]

		if (expected === undefined || predicted === undefined) continue

		const key = `${expected}\0${predicted}`
		const existing = tally.get(key)

		if (existing) {
			existing.n++
		} else {
			tally.set(key, { expected, predicted, n: 1 })
		}
	}

	return [...tally.values()].toSorted((a, b) => b.n - a.n).slice(0, limit)
}

/**
 * Split a sample by one stratum key and curve each group, grouping observations
 * missing the key under `(unset)` rather than dropping them, because dropping those
 * rows moves the denominator of every other group.
 */
export function curveByStratum(
	sample: readonly Observation[],
	key: string,
	binCount: number
): Record<string, ReliabilityCurve> {
	const groups = new Map<string, Observation[]>()

	for (const observation of sample) {
		const value = observation.strata[key] ?? "(unset)"
		const group = groups.get(value)

		if (group) {
			group.push(observation)
		} else {
			groups.set(value, [observation])
		}
	}

	return Object.fromEntries(
		[...groups.entries()]
			.toSorted(([a, x], [b, y]) => y.length - x.length || a.localeCompare(b))
			.map(([value, group]) => [value, reliabilityCurve(group, binCount)])
	)
}
