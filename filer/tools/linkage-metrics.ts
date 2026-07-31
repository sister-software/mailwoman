/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Pairwise grouping precision/recall/F1 (3b Task 4, decision 4) — scores a PREDICTED "same group"
 *   judgment against a TRUTH partition over the same id universe. Built for {@linkcode filerLinkageEval}
 *   (`linkage-eval.ts`), which scores `cluster-filers.ts`'s entity-clustering output against held-out
 *   FRN↔holdingCompany family truth, but the types here are generic — nothing below is filer-specific —
 *   because the same shape ("does a clustering recover a held-out grouping?") recurs anywhere this SDK
 *   adds a linkage eval.
 *
 *   **Why pairwise, not a cluster-alignment metric (B-cubed, the Hungarian algorithm):** a "positive"
 *   here is an unordered PAIR of ids judged to belong to the same group — true/false positive/negative are
 *   counted over pairs, never over clusters, so no cluster-to-cluster correspondence ever has to be
 *   chosen. That matters specifically for {@linkcode filerLinkageEval}'s use: an authoritative cluster's
 *   `cluster_id` is content-derived (`cluster-filers.ts`'s `` `${assertion}:${lexicographically-smallest
 *   member}` ``) and has no "correct" counterpart in the truth partition to align against — the only
 *   question that matters is "are these two records correctly judged together or apart," which is
 *   well-defined over pairs without an alignment step. `registry/tools/train-gbt.ts`'s (unexported)
 *   `clusterF1` makes the identical pairwise choice for an analogous problem (does `resolveEntities`'
 *   clustering recover the true NPI grouping?) — evidence pairwise is the right shape for THIS kind of
 *   experiment too, not just a borrowed convenience. It isn't reused here (per the task brief): it
 *   hard-codes a `{records}`/NPI-shaped input, and its zero-denominator convention is one this module
 *   deliberately replaces — see below.
 *
 *   **Zero-denominator convention (deliberately NOT `clusterF1`'s):** `clusterF1` defaults an empty
 *   denominator to `0` for both precision and recall, silently. This module reports `null` instead — "the
 *   prediction made no positive calls at all" and "every positive call the prediction made was wrong" are
 *   different, honest facts, and collapsing them into the same `0` would misreport a linkage that
 *   predicted NOTHING (this module's own primary use case — see {@linkcode filerLinkageEval}'s scorecard)
 *   as indistinguishable from one that confidently predicted the wrong thing everywhere.
 *
 *   **`f1` propagates that `null` rather than collapsing it (task 4 review fix, I2).** The first version of
 *   this module argued the case above for `precision`/`recall` and then handed back `f1: 0` whenever
 *   `truePositivePairs === 0`, which threw the distinction away again on the one field a reader quotes as
 *   the headline. Worked example: a PERFECT prediction over an all-singleton truth partition (nothing to
 *   merge, nothing merged) has no defined precision and no defined recall, and reported `f1: 0` —
 *   arithmetically indistinguishable from a linkage that got every call wrong. So `f1` is `null` whenever
 *   `precision` or `recall` is `null`, `0` when both are defined and `truePositivePairs === 0` (a genuine,
 *   measurable miss with positive calls made and positive pairs available), and the ordinary harmonic mean
 *   otherwise. A `null` here means "this run does not support an F1", not "this run scored zero"; render it
 *   as `N/A`, never as `0.000`.
 */

/**
 * {@linkcode scorePairwiseGrouping}'s result. Every count is over UNORDERED pairs drawn from the `ids` passed in — see
 * the module docstring for why pairs, not aligned clusters.
 */
export interface PairwiseGroupingScore {
	/**
	 * Pairs the truth partition puts together AND the prediction puts together.
	 */
	truePositivePairs: number
	/**
	 * Pairs the prediction puts together that the truth partition does NOT — a false merge.
	 */
	falsePositivePairs: number
	/**
	 * Pairs the truth partition puts together that the prediction does NOT — a missed link.
	 */
	falseNegativePairs: number
	/**
	 * `truePositivePairs + falseNegativePairs` — every pair the truth partition asserts belongs to the same group.
	 */
	truthPositivePairs: number
	/**
	 * `truePositivePairs + falsePositivePairs` — every pair the prediction asserts belongs to the same group.
	 */
	predictedPositivePairs: number
	/**
	 * Total unordered pairs scored (`ids.length` choose 2).
	 */
	totalPairs: number
	/**
	 * `truePositivePairs / predictedPositivePairs`, or `null` when the prediction made zero positive calls — see the
	 * module docstring's "zero-denominator convention".
	 */
	precision: number | null
	/**
	 * `truePositivePairs / truthPositivePairs`, or `null` when the truth partition has no positive pairs to recover at
	 * all (every id is its own singleton truth group).
	 */
	recall: number | null
	/**
	 * `null` whenever `precision` or `recall` is `null` — an F1 over an undefined component is undefined, not zero (task
	 * 4 review fix, I2; see the module docstring's worked example). `0` when both are defined and `truePositivePairs ===
	 * 0` (the harmonic mean of two zeros, reported as the `0` it is rather than `NaN`). Otherwise the ordinary harmonic
	 * mean of `precision`/`recall`.
	 */
	f1: number | null
}

/**
 * Score a `predictedSame` pairwise predicate against a `truthSame` one, over every unordered pair drawn from `ids`.
 * Both predicates are called once per pair (`ids.length` choose 2 — O(n²)) — fine for an eval-scale id universe (this
 * SDK's callers run this over tens of FRNs, not millions); not intended for production-scale record linkage.
 *
 * Accepting predicates rather than two group-id maps is deliberate: a TRUTH grouping is usually a clean partition (one
 * group id per id — see {@linkcode groupPredicateFromMap}), but a PREDICTED grouping can legitimately be the union of
 * several independent partitions (e.g. {@linkcode filerLinkageEval} treats two FRNs as predicted-same when they share
 * EITHER an authoritative OR an inferred cluster id) — a single group-id map can't express that "OR", but a predicate
 * can.
 */
export function scorePairwiseGrouping<Id>(
	ids: readonly Id[],
	truthSame: (a: Id, b: Id) => boolean,
	predictedSame: (a: Id, b: Id) => boolean
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

	// I2: `null` in, `null` out — never `0`. `0` is reserved for the case both components are DEFINED and the
	// prediction still recovered nothing, which is a measurement; an undefined component is the absence of one.
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
 * Builds a `truthSame`/`predictedSame`-shaped predicate from a group-id map — the common case, where "same group" means
 * "maps to the identical group id" (a genuine partition, unlike {@linkcode scorePairwiseGrouping}'s general predicate
 * form). Two ids missing from `groupOf` entirely are never treated as "same" (both `undefined` would otherwise compare
 * equal) — every id scored must carry an explicit group assignment.
 */
export function groupPredicateFromMap<Id>(groupOf: ReadonlyMap<Id, string>): (a: Id, b: Id) => boolean {
	return (a, b) => {
		const groupA = groupOf.get(a)

		return groupA !== undefined && groupA === groupOf.get(b)
	}
}
