/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Reliability curves compare reported confidence with observed correctness. This module is pure;
 *   surface-specific confidence collection lives in `reliability-surfaces.ts`.
 */

/**
 * One graded confidence.
 *
 * `strata` is free-form on purpose. A surface knows what its own useful splits are — tag and locale for the decode
 * path, expected/predicted country for the placer — and a fixed field list would either omit one or force every surface
 * to carry the others empty.
 */
export interface Observation {
	confidence: number
	correct: boolean
	strata: Record<string, string>
}

export interface ReliabilityBin {
	lower: number
	upper: number
	n: number
	/**
	 * `null` on an empty bin. Zero would be a claim about a mean nothing contributed to.
	 */
	mean_confidence: number | null
	accuracy: number | null
	/**
	 * `accuracy - mean_confidence`, SIGNED. Negative is overconfidence — the direction that lets a caller trust a wrong
	 * answer — and an unsigned gap cannot tell it from the harmless direction.
	 */
	gap: number | null
}

export interface ReliabilityCurve {
	n: number
	accuracy: number | null
	/**
	 * Expected calibration error: the population-weighted mean absolute gap. `null` on an empty sample, because 0 there
	 * and 0 on a perfect model are the same number and opposite facts.
	 */
	ece: number | null
	/**
	 * Maximum calibration error: the worst single bin, unweighted. Reported beside ECE rather than instead of it — a
	 * rare, badly calibrated bin barely moves ECE and dominates MCE, so the pair says something neither says alone.
	 */
	mce: number | null
	bins: ReliabilityBin[]
}

export interface ThresholdRow {
	threshold: number
	admitted: number
	admitted_share: number
	/**
	 * Accuracy among the admitted. `null` when nothing is admitted — an eval that admits nothing has no precision, and
	 * reporting 0 there reads as an eval that admits only errors.
	 */
	precision_above: number | null
	errors_admitted: number
	/**
	 * Correct observations the eval turned away. The cost side of the trade, which a precision column alone hides.
	 */
	correct_below: number
}

/**
 * Equal-width bins over [0, 1].
 *
 * Empty bins are RETAINED. A model whose confidences never enter the low bins is itself the finding, and a table that
 * silently starts at 0.8 reads as a narrower measurement rather than as a wider result.
 */
export function reliabilityCurve(sample: readonly Observation[], binCount: number): ReliabilityCurve {
	const bins: Observation[][] = Array.from({ length: binCount }, () => [])

	for (const observation of sample) {
		// `Math.min` rather than a bare floor: a confidence of exactly 1.0 indexes one past the last bin, and dropping
		// it would silently exclude the most-confident observations — the population an eval cares about most.
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
 * What a confidence floor at each threshold would actually buy.
 *
 * The curve says whether the number is honest; this says what to DO with it, and they are different questions — a
 * well-calibrated surface can still have no threshold worth setting, because the admitted-error count at every useful
 * recall is too high. Both columns of the trade are reported: a precision figure alone hides the correct answers the
 * check throws away.
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

export interface ErrorClass {
	expected: string
	predicted: string
	n: number
}

/**
 * The confusions an eval at `threshold` lets through, most frequent first.
 *
 * Restricted to the ADMITTED errors on purpose. A hard filter's cost is asymmetric — an admitted error scopes the whole
 * downstream resolve to the wrong answer, while a rejection only forgoes the narrowing — so the per-class rate above
 * the eval is the number that decides whether the eval is safe, and the overall confusion matrix is not.
 *
 * Requires `expected` and `predicted` strata; a surface without them (the decode path grades a value against a label
 * and has no second class to name) returns nothing, which is absence and not a clean confusion matrix.
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
 * Split a sample by one stratum key and curve each group.
 *
 * A group is keyed by the stratum's VALUE, and observations missing the key are grouped under `(unset)` rather than
 * dropped — a stratum that half the sample does not carry is a fact about the corpus, and dropping those rows moves the
 * denominator of every other group without saying so.
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
