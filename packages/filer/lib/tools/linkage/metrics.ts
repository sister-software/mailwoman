/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Pairwise grouping precision/recall/F1 over unordered id pairs.
 *
 * A zero denominator reports `null` rather than `0`, because "the prediction made no positive calls" and "every positive call was wrong" are different facts, and `f1` propagates that `null` rather than collapsing it.
 */

/**
 * `{@linkcode scorePairwiseGrouping}`'s result, with every count taken over unordered pairs drawn from the `ids` passed in.
 */
export interface PairwiseGroupingScore {
	/**
	 * Pairs both the truth partition and the prediction put together.
	 */
	truePositivePairs: number
	/**
	 * Pairs the prediction puts together that the truth partition does not.
	 */
	falsePositivePairs: number
	/**
	 * Pairs the truth partition puts together that the prediction does not.
	 */
	falseNegativePairs: number
	/**
	 * Every pair the truth partition asserts belongs to the same group.
	 */
	truthPositivePairs: number
	/**
	 * Every pair the prediction asserts belongs to the same group.
	 */
	predictedPositivePairs: number
	/**
	 * Total unordered pairs scored (`ids.length` choose 2).
	 */
	totalPairs: number
	/**
	 * `truePositivePairs / predictedPositivePairs`, or `null` when the prediction made zero positive calls.
	 */
	precision: number | null
	/**
	 * `truePositivePairs / truthPositivePairs`, or `null` when the truth partition has no positive pairs.
	 */
	recall: number | null
	/**
	 * `null` whenever `precision` or `recall` is `null`, and `0` when both are defined and `truePositivePairs === 0`; otherwise the harmonic mean of `precision` and `recall`.
	 */
	f1: number | null
}

/**
 * Scores a `predictedSame` pairwise predicate against a `truthSame` one over every unordered pair drawn from `ids`
 * (O(n²), eval-scale only), accepting predicates rather than group-id maps because a predicted grouping need not be a partition.
 */
export function scorePairwiseGrouping<ID>(
	ids: readonly ID[],
	truthSame: (a: ID, b: ID) => boolean,
	predictedSame: (a: ID, b: ID) => boolean
): PairwiseGroupingScore {
	let truePositivePairs = 0
	let falsePositivePairs = 0
	let falseNegativePairs = 0
	let totalPairs = 0

	for (let i = 0; i < ids.length; i++) {
		for (let j = i + 1; j < ids.length; j++) {
			const a = ids[i]!
			const b = ids[j]!
			const truth = truthSame(a, b)
			const predicted = predictedSame(a, b)

			totalPairs++

			if (truth && predicted) {
				truePositivePairs++
			} else if (predicted) {
				falsePositivePairs++
			} else if (truth) {
				falseNegativePairs++
			}
		}
	}

	const truthPositivePairs = truePositivePairs + falseNegativePairs
	const predictedPositivePairs = truePositivePairs + falsePositivePairs

	const precision = predictedPositivePairs > 0 ? truePositivePairs / predictedPositivePairs : null
	const recall = truthPositivePairs > 0 ? truePositivePairs / truthPositivePairs : null

	// `null` in, `null` out — `0` is reserved for a measured miss with both components defined.
	let f1: number | null = null

	if (precision !== null && recall !== null) {
		f1 = truePositivePairs === 0 ? 0 : (2 * precision * recall) / (precision + recall)
	}

	return {
		truePositivePairs,
		falsePositivePairs,
		falseNegativePairs,
		truthPositivePairs,
		predictedPositivePairs,
		totalPairs,
		precision,
		recall,
		f1,
	}
}

/**
 * Builds a `truthSame`/`predictedSame`-shaped predicate from a group-id map, treating a missing assignment as never `same` rather than comparing two `undefined` values equal.
 */
export function groupPredicateFromMap<ID>(groupOf: ReadonlyMap<ID, string>): (a: ID, b: ID) => boolean {
	return (a, b) => {
		const groupA = groupOf.get(a)

		return groupA !== undefined && groupA === groupOf.get(b)
	}
}
