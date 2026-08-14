/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The locality-ranking weights and their shipped defaults. Its own module because every value here is
 *   a measured tuning decision with its rationale attached — the block reads as a reference table, not
 *   as part of the lookup's control flow, and the tests import it directly to pin one lever at a time.
 */

/**
 * Ranking weights for `findPlace`. Tweakable per-instance but defaults match the values declared in the Phase 4.2 plan
 * doc.
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
	 * Magnitude of the proximity boost when the query carries `near`. The contribution is `proximityBoost / (1 +
	 * distanceKm / proximityScaleKm)` — at distance 0 the boost is full magnitude, at `proximityScaleKm` it's half,
	 * decaying further with distance. Default tuned so proximity can overcome a typical FTS rank tie but not dominate a
	 * strong text match.
	 */
	proximityBoost: number
	/**
	 * Magnitude of the bias-hint term inside the exact-tier PROMINENCE sort (the `bias`/viewport path). Deliberately
	 * population-scale (default = populationBoost) so a candidate near the map view / the user beats a distant-but-bigger
	 * namesake — "the map view wins" is the feature; same-region ties (all candidates far from every hint) still fall to
	 * population.
	 */
	biasBoost: number
	/**
	 * Distance (km) at which the proximity boost halves. Tune to the typical query radius.
	 */
	proximityScaleKm: number
	/**
	 * Magnitude of the population boost when the candidate has a known `wof:population`. The contribution is
	 * `populationBoost * log10(1 + population) / populationScaleLog10`, capped at `populationBoost`. WOF only carries
	 * population for ~15% of localities (mostly larger ones); places without it get +0 (never a penalty). Default tuned
	 * so the famous Springfield, IL (pop ~112k) gets ~0.42 boost — enough to nudge past tiny same-name peers.
	 */
	populationBoost: number
	/**
	 * Population (in log10) at which the boost reaches its full magnitude. Default 6 — i.e. a population of 1,000,000
	 * gives `populationBoost` exactly. Larger populations cap at the same value (no compounding effect for megacities).
	 */
	populationScaleLog10: number
	/**
	 * Tier candidates with an EXACT name/alias match above candidates that only match partially, BEFORE the weighted-sum
	 * score is consulted. Default true.
	 *
	 * Why this is needed (and why it ALIGNS with — rather than overrides — the population/importance signal): the
	 * weighted sum adds population as a large additive boost (`populationBoost`, up to +4) so that famous places surface
	 * for unambiguous full-name queries. But population is a _prominence prior_ — its job is to break ties among
	 * candidates that match the query EQUALLY WELL (e.g. "Springfield" → Springfield IL over Springfield MA, both exact
	 * name matches). It was never meant to promote a place that matches the query WORSE. For a 2-letter region
	 * abbreviation that backfires: querying "ME" returns Maine (which has the exact alias `ME`) AND Missouri/
	 * Michigan/etc. (which do not), and Missouri's larger population (+4) overcomes Maine's bm25 edge — so "Portland, ME"
	 * resolves its region to Missouri and the locality then cascades to the wrong state. Tiering restores the intended
	 * ordering: **match quality is the primary key, prominence (population) the secondary key WITHIN a tier.**
	 * Springfield-IL-over-MA still works (both exact → same tier → population decides); ME→Maine now works (only Maine is
	 * exact → higher tier → population never gets to override it). See
	 * docs/articles/evals/resolver-geo/2026-05-30-resolver-exact-match.md.
	 *
	 * Note: tiering re-ranks within the over-fetched candidate window (`limit * 4`); a pathological exact match that
	 * falls outside that window is not rescued. For the region-abbrev case the window is comfortably sufficient (a
	 * handful of states match a 2-letter query).
	 */
	exactMatchTiering: boolean
	/**
	 * #936 option 3 — official-language names ARE names. When true, a candidate holding the query as an OFFICIAL name
	 * (`names.official = 1`: a preferred-form name in an official language of its country, stamped at ingest) joins the
	 * NAME-exact sub-tier rather than the alias-exact one, provided its population clears {@link officialNameExactFloor}.
	 * Fixes unscoped "Åbo" → Turku (its official Swedish name) over a hamlet literally named Åbo; population still orders
	 * within the sub-tier, so Paris → Paris FR is untouched.
	 *
	 * Default true (operator-promoted 2026-07-03 after the pre-registered gate battery: four intended exonym flips —
	 * Berne→Bern, Bruges→Brugge, Roma→Rome, Åbo→Turku — with the namesake/abbreviation rows and the US/FI panels
	 * byte-identical). Requires a gazetteer carrying the #940 ingest bit — on older DBs without the `official` column the
	 * probe fails soft and behavior is identical to the flag being off.
	 */
	officialNameExact: boolean
	/**
	 * Minimum population for a candidate's official names to join the name-exact sub-tier. The #936 review's no-floor
	 * census measured the boundary: ≥100k holders are the famous-exonym class (757 flips, intent-correct; 7 collisions,
	 * none harmful) while 10k–100k holders are junk-dominated (3,481 flips led by short-form mis-tags — Villeneuve-Loubet
	 * carrying "villeneuve" would bury five real villages of that name). Rank-time knob: tunable without re-ingest;
	 * below-floor official names simply stay alias-tier (today's behavior).
	 */
	officialNameExactFloor: number
}

/**
 * The shipped weights. Every value is a measured decision — change one and re-run the resolver eval; the per-field docs
 * on {@link RankingWeights} say what each lever moves and what motivated its current value.
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
	// populationBoost is intentionally large — empirical tuning against real WOF showed BM25 gaps
	// of 1.5-3.0 between famous places and tiny same-name peers (because the famous ones have
	// hundreds of alt-name entries that hurt their FTS document score). To consistently surface
	// "the famous one" for unambiguous queries like "New York" or "Chicago", the population signal
	// needs to dominate. Callers wanting a more conservative balance can drop this in the
	// RankingWeights override.
	//
	// Note: this resolver uses `place_population` directly. The separate `place_importance` table
	// (Wikipedia-derived) is consumed by the FST layer, not here. See
	// docs/articles/concepts/importance-vs-population.md for the two-signal contract.
	populationBoost: 4,
	populationScaleLog10: 6,
	// Exact name/alias match outranks partial match before the weighted sum (incl. population) is
	// consulted — keeps population as an intra-tier prominence tiebreaker, not a cross-tier promoter.
	// Fixes the 2-letter-region-abbrev bug ("ME" → Maine, not the more-populous Missouri).
	exactMatchTiering: true,
	// #936 option 3 — promoted default-ON 2026-07-03 (gate battery PASS; see the RankingWeights docstring).
	officialNameExact: true,
	officialNameExactFloor: 100_000,
}
