/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The Fellegi-Sunter scorer — the matcher's decision layer.
 *
 *   Each field comparison lands a record pair in a discrete _agreement level_ (exact / high / low /
 *   different / missing). Each level carries two probabilities: `m` = P(this level | the pair
 *   really matches) and `u` = P(this level | it doesn't). Their ratio is a Bayes factor, and its
 *   log is the level's contribution to the total match weight in bits:
 *
 *   ```
 *   M = log2(λ / (1 - λ))  +  Σ_fields  log2(m_level / u_level)
 * ```
 *
 *   — a prior (how likely any two random records match) plus an additive, per-field-attributable
 *   stack of evidence. Convert `M` to a probability and threshold it: above the upper bound is a
 *   link, below the lower bound a non-link, and the band between is _clerical review_ — the
 *   calibrated abstain zone the whole design leans on.
 *
 *   The `m`/`u` numbers here are NOT universal constants. They are estimated from the data — by EM,
 *   unsupervised (the next increment) — and the term-frequency adjustment that makes a rare-name
 *   agreement count more than a common one layers on top. This module is the deterministic core
 *   those build on: given the levels, it produces the weights, the probability, and the decision.
 */

import { nameSimilarity } from "./comparators.js"

/** One agreement level of a comparison, with its match / non-match probabilities. */
export interface ComparisonLevel {
	/** Human-readable label for debugging (`exact`, `high`, `different`). */
	label: string
	/** P(a pair lands in this level | it is a true match). A measure of data quality. */
	m: number
	/** P(a pair lands in this level | it is NOT a match). A measure of coincidence / cardinality. */
	u: number
	/** For similarity-driven comparisons: the minimum similarity (inclusive) to qualify. */
	minSimilarity?: number
	/** For distance-driven comparisons: the maximum distance in km (inclusive) to qualify. */
	maxKm?: number
}

/** A per-field comparison: pull a value from each record and assign an agreement level. */
export interface Comparison<R> {
	/** Field name, for attribution. */
	name: string
	/** Levels ordered highest agreement → lowest (`exact` first, `different` last). */
	levels: ComparisonLevel[]
	/** Index into {@link levels}, or `-1` when either value is missing (no evidence → weight 0). */
	assess(a: R, b: R): number
	/**
	 * Optional term-frequency adjustment: on the levels it names, replace the level's average `u`
	 * with the agreeing value's actual frequency, so agreement on a rare value (`Vijayan`) outweighs
	 * agreement on a common one (`Smith`). See `withTermFrequency`.
	 */
	termFrequency?: TermFrequencyAdjustment<R>
}

/**
 * Per-value term-frequency adjustment for a comparison (the Splink/Winkler mechanism). `m` is
 * unchanged; on an agreement level the effective `u` becomes the value's own frequency, adding
 * `log2(u_level / frequency)` to the weight — large and positive for rare values, negative for
 * common ones. Floored at {@link TermFrequencyAdjustment.minimumFrequency} so an ultra-rare value
 * can't produce an unbounded boost.
 */
export interface TermFrequencyAdjustment<R> {
	/** Relative frequency of a value in the data, in (0, 1]. Typically computed on-the-fly. */
	frequency(value: string): number
	/** The level indices the adjustment applies to (typically just the exact level). */
	levels: ReadonlySet<number>
	/** The agreeing value to look up for a pair (a normalized field value), or null to skip. */
	value(a: R, b: R): string | null | undefined
	/** Scale the adjustment in [0, 1]. Default 1. */
	weight?: number
	/** Floor for the looked-up frequency, bounding the boost on ultra-rare values. Default 1e-4. */
	minimumFrequency?: number
}

/** A Fellegi-Sunter model: the field comparisons plus the prior match rate `λ`. */
export interface FellegiSunterModel<R> {
	comparisons: Comparison<R>[]
	/** Prior probability that two records drawn at random are a match. */
	lambda: number
}

/** The scored outcome for one record pair. */
export interface PairScore {
	/** Total match weight in bits (`log2` odds). */
	weight: number
	/** Match probability in [0, 1]. */
	probability: number
	/** Per-field breakdown — what drove the score. */
	contributions: Array<{ name: string; level: string | null; weight: number }>
}

/** The terminal decision for a pair under upper / lower match-weight thresholds. */
export type MatchDecision = "match" | "review" | "non-match"

/** The Bayes-factor weight of a single level, in bits: `log2(m / u)`. */
export function levelWeight(level: ComparisonLevel): number {
	if (level.u <= 0) return level.m > 0 ? Infinity : 0
	return Math.log2(level.m / level.u)
}

/** The prior match weight in bits: `log2(λ / (1 - λ))`. */
export function priorWeight(lambda: number): number {
	if (lambda <= 0) return -Infinity
	if (lambda >= 1) return Infinity
	return Math.log2(lambda / (1 - lambda))
}

/** Convert a total match weight (bits) to a probability, numerically stable for extreme weights. */
export function probabilityFromWeight(weight: number): number {
	return 1 / (1 + 2 ** -weight)
}

/**
 * A comparison driven by a similarity function and a tier of `minSimilarity` thresholds (the
 * StatCan/Splink recipe). Levels must be ordered highest → lowest similarity, the last acting as
 * the `different` catch-all (`minSimilarity` 0). A missing value on either side yields no
 * evidence.
 */
export function similarityComparison<R>(config: {
	name: string
	extract: (record: R) => string | null | undefined
	/** Defaults to {@link nameSimilarity}. */
	similarity?: (a: string, b: string) => number
	levels: ComparisonLevel[]
}): Comparison<R> {
	const similarity = config.similarity ?? nameSimilarity

	return {
		name: config.name,
		levels: config.levels,
		assess(a, b) {
			const va = config.extract(a)
			const vb = config.extract(b)
			if (!va || !vb || !va.trim() || !vb.trim()) return -1

			const sim = similarity(va, vb)
			for (let i = 0; i < config.levels.length; i++) {
				if (sim >= (config.levels[i]!.minSimilarity ?? 0)) return i
			}
			return config.levels.length - 1
		},
	}
}

/** Score a record pair: total match weight, probability, and the per-field contributions. */
export function scorePair<R>(model: FellegiSunterModel<R>, a: R, b: R): PairScore {
	let weight = priorWeight(model.lambda)
	const contributions: PairScore["contributions"] = []

	for (const comparison of model.comparisons) {
		const index = comparison.assess(a, b)
		if (index < 0) {
			contributions.push({ name: comparison.name, level: null, weight: 0 })
			continue
		}
		const level = comparison.levels[index]!
		let w = levelWeight(level)

		// Term-frequency adjustment: swap the level's average u for the agreeing value's own frequency.
		const tf = comparison.termFrequency
		if (tf && tf.levels.has(index) && level.u > 0) {
			const value = tf.value(a, b)
			if (value) {
				const frequency = Math.max(tf.frequency(value), tf.minimumFrequency ?? 1e-4)
				if (frequency > 0) w += Math.log2(level.u / frequency) * (tf.weight ?? 1)
			}
		}

		weight += w
		contributions.push({ name: comparison.name, level: level.label, weight: w })
	}

	return { weight, probability: probabilityFromWeight(weight), contributions }
}

/**
 * Classify a score against upper / lower match-weight thresholds (in bits): at or above `upper` is
 * a link, at or below `lower` a non-link, and the band between is clerical review (abstain).
 */
export function decide(score: PairScore, thresholds: { upper: number; lower: number }): MatchDecision {
	if (score.weight >= thresholds.upper) return "match"
	if (score.weight <= thresholds.lower) return "non-match"
	return "review"
}
