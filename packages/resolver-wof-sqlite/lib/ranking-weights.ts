/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The locality-ranking weights and their shipped defaults. Its own module because every value here is
 *   a measured tuning decision with its rationale attached. The block reads as a reference table rather than
 *   as part of the lookup's control flow, and the tests import it directly to pin one change at a time.
 */

/**
 * Ranking weights for `findPlace`.
 *
 * Tweakable per-instance but defaults match the values declared in the Phase 4.2 plan doc.
 */
export interface RankingWeights {
	/**
	 * Boost when the candidate's placetype matches an explicit `placetype` filter.
	 */
	placetypeMatchBoost: number
	/**
	 * Boost when the candidate is a locality and no explicit placetype was requested.
	 */
	localityImplicitBoost: number
	/**
	 * Boost when the candidate's country matches an explicit `country` filter.
	 */
	countryMatchBoost: number
	/**
	 * Boost when the candidate is a direct child of the requested `parentID`.
	 */
	directChildBoost: number
	/**
	 * Boost when the candidate is a transitive descendant of the requested `parentID`.
	 */
	descendantBoost: number
	/**
	 * Multiplier on the length-penalty term (penalizes much-longer-than-query names).
	 */
	lengthPenaltyWeight: number
	/**
	 * Magnitude of the proximity boost when the query carries `near`.
	 *
	 * The contribution is `proximityBoost / (1 + distanceKm / proximityScaleKm)`. At distance 0
	 * the boost is full magnitude, at `proximityScaleKm` it is half, and it decays further with
	 * distance.
	 * Default tuned so proximity can overcome a typical FTS rank tie but not dominate a strong text match.
	 */
	proximityBoost: number
	/**
	 * Magnitude of the bias-hint term inside the exact-tier prominence sort (the `bias`/viewport path).
	 *
	 * Deliberately population-scale (default = populationBoost), so a candidate near the map view
	 * or the user beats a distant-but-bigger namesake. "The map view wins" is the feature.
	 * Same-region ties, where all candidates are far from every hint, still fall to population.
	 */
	biasBoost: number
	/**
	 * Distance (km) at which the proximity boost halves.
	 *
	 * Tune to the typical query radius.
	 */
	proximityScaleKm: number
	/**
	 * Magnitude of the population boost when the candidate has a known `wof:population`.
	 *
	 * The contribution is `populationBoost * log10(1 + population) / populationScaleLog10`,
	 * capped at `populationBoost`.
	 * WOF only carries population for about 15% of localities (mostly larger ones), and places
	 * without it get +0, never a penalty.
	 *
	 * Default tuned so the famous Springfield, IL (pop ~112k) gets about a 0.42 boost, enough to
	 * nudge past tiny same-name peers.
	 */
	populationBoost: number
	/**
	 * Population (in log10) at which the boost reaches its full magnitude.
	 *
	 * Default 6, so a population of 1,000,000 gives `populationBoost` exactly.
	 * Larger populations cap at the same value (no compounding effect for megacities).
	 */
	populationScaleLog10: number
	/**
	 * Tier candidates with an exact name/alias match above candidates that only match
	 * partially, before the weighted-sum score is consulted.
	 *
	 * Default true.
	 *
	 * The weighted sum adds population as a large additive boost, so famous places surface for
	 * unambiguous full-name queries. Population is a prominence prior, and its job is to break ties
	 * among candidates that match the query equally well, as in "Springfield" → Springfield IL over
	 * Springfield MA. It does not promote a place that matches the query worse, and tiering keeps
	 * match quality as the primary key with prominence secondary within a tier.
	 *
	 * Note: tiering re-ranks within the over-fetched candidate window (`limit * 4`), so a
	 * pathological exact match outside that window is not rescued.
	 */
	exactMatchTiering: boolean
	/**
	 * Official-language names count as names. When true, a candidate holding the query as an official
	 * name (`names.official = 1`, a preferred-form name in an official language of its country,
	 * stamped at ingest) joins the name-exact sub-tier rather than the alias-exact one, provided its
	 * population clears {@link officialNameExactFloor}.
	 *
	 * Fixes unscoped "Åbo" → Turku (its official Swedish name) over a hamlet literally named Åbo.
	 * Population still orders within the sub-tier, so Paris → Paris FR is untouched.
	 *
	 * Default true. It requires a gazetteer carrying the `official` ingest bit, and on older DBs
	 * without the `official` column the probe fails soft and behavior matches the flag being off.
	 */
	officialNameExact: boolean
	/**
	 * Minimum population for a candidate's official names to join the name-exact sub-tier.
	 *
	 * The floor separates the famous-exonym class from a junk-dominated one led by short-form
	 * mis-tags, where a place carrying a short form would bury real villages of that name. This is a
	 * rank-time knob, tunable without re-ingest. Below-floor official names stay in the alias tier.
	 */
	officialNameExactFloor: number
}

/**
 * The shipped weights.
 *
 * Every value is a measured decision, so change one and re-run the resolver eval. The per-field
 * docs on {@link RankingWeights} say what each change moves.
 */
export const DEFAULT_WEIGHTS: RankingWeights = {
	placetypeMatchBoost: 0.5,
	localityImplicitBoost: 0.2,
	countryMatchBoost: 0.3,
	directChildBoost: 0.5,
	descendantBoost: 0.2,
	lengthPenaltyWeight: 0.1,
	proximityBoost: 0.8,
	proximityScaleKm: 100,
	biasBoost: 4,
	// populationBoost is intentionally large. Real WOF showed BM25 gaps of 1.5 to 3.0 between famous
	// places and tiny same-name peers, because the famous ones have hundreds of alt-name entries that
	// hurt their FTS document score. This resolver reads `place_population` directly. The separate
	// Wikipedia-derived `place_importance` table is consumed by the FST layer.
	populationBoost: 4,
	populationScaleLog10: 6,
	// Exact name and alias matches outrank partial matches before the weighted sum, which keeps
	// population as an intra-tier prominence tiebreaker instead of a cross-tier promoter.
	exactMatchTiering: true,
	officialNameExact: true,
	officialNameExactFloor: 100_000,
}

/**
 * The population contribution as a 0..1 fraction: `min(1, log10(1 + population) / populationScaleLog10)`.
 *
 * Zero for an absent or non-positive population, and zero for a non-positive scale,
 * so a magnitude never carries its own absence.
 * The coordinate-first locality path consumes this fraction directly, and {@link populationBoostTerm}
 * scales it.
 */
export function populationScaleTerm(
	population: number | null | undefined,
	weights: Pick<RankingWeights, "populationScaleLog10">
): number {
	if (population == null || population <= 0 || weights.populationScaleLog10 <= 0) return 0

	return Math.min(1, Math.log10(1 + population) / weights.populationScaleLog10)
}

/**
 * The additive population boost: `populationBoost * populationScaleTerm(...)`,
 * capped at `populationBoost` magnitude at `10^populationScaleLog10` people.
 *
 * Missing population contributes 0, never a penalty.
 * The one formula behind the Node weighted sum and the wasm re-rank, so the two backends cannot drift.
 */
export function populationBoostTerm(
	population: number | null | undefined,
	weights: Pick<RankingWeights, "populationBoost" | "populationScaleLog10">
): number {
	return weights.populationBoost * populationScaleTerm(population, weights)
}
