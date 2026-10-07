/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The referential score and its comparator implement the ranking half of the two-score split.
 *   ROAD_TO_V9 §2 R1 ratified the split on 2026-08-06.
 *
 *   the policy. "The importance of a knowledge-base article is not the probability that this is the
 *   place the user means." A geocoder ranks by referential likelihood.
 *   Encyclopedic importance is stored as data and never serves as a ranking key.
 *   Saint-Denis demonstrates the distinction.
 *   The Seine-Saint-Denis suburb (population 96,128) has encyclopedic importance 0.1173.
 *   The Aude hamlet (population 418) has importance 0.5683.
 *   Encyclopedic ranking places the hamlet above the suburb, despite the 4.8× population difference.
 *
 *   This value lives in `@mailwoman/core` because three packages need the same number:
 *   `@mailwoman/resolver` (backend-agnostic — it cannot import a backend),
 *   `@mailwoman/resolver-wof-sqlite` owns the gazetteer schema and both lookups.
 *   The FST builder stamps referential scores into the decode-bias artifact.
 *   `core/resolver/types.ts` owns the shared `ResolvedPlace` interface, so the score belongs beside it.
 */

/**
 * Population divisor in {@link referentialFromPopulation}.
 *
 * A 1,000-person place scores `log2(2)/14` — the curve starts counting at the scale
 * where WOF actually records population.
 */
export const REFERENTIAL_POPULATION_DIVISOR = 1000

/**
 * Log2 denominator in {@link referentialFromPopulation}. 14 puts the ceiling at `2^14 · 1000` people.
 */
export const REFERENTIAL_LOG2_SCALE = 14

/**
 * The population at which {@link referentialFromPopulation} saturates at exactly 1.0:
 * `(2^14 − 1) · 1000` = 16,383,000.
 *
 * Required rather than trivia.
 * Above this the score clamps, so two megacities that population would order
 * (Tokyo ~37 M vs Delhi ~33 M) tie at 1.0.
 *
 * Any ranking keyed only on referential must break that tie with raw population.
 * This preserves the population-first ordering. {@link compareReferential} provides that
 * tiebreak so callers do not repeat a bare subtraction at each call site.
 */
export const REFERENTIAL_SATURATION_POPULATION = (2 ** REFERENTIAL_LOG2_SCALE - 1) * REFERENTIAL_POPULATION_DIVISOR

/**
 * Population → referential likelihood in [0, 1].
 *
 * `min(1, log2(1 + pop/1000) / 14)`.
 * The FST builder has used this formula for its population fallback since the FST shipped.
 *
 * `gazetteer importance` uses the same formula for fallback rows.
 *
 * This declaration keeps three values identical by construction.
 * The shared values are the decode-bias artifact's values and the gazetteer's `referential` column.
 * The resolver uses the same value as its ranking key.
 *
 * An absent population row and a recorded population of 0 both return 0.
 * Zero means "no population evidence".
 * The ranking treats it as no boost, never a penalty.
 *
 * WOF records population for roughly 15% of localities, so absence is the common case and must stay cheap.
 */
export function referentialFromPopulation(population: number | null | undefined): number {
	if (population === null || population === undefined || population <= 0) return 0

	return Math.min(1, Math.log2(1 + population / REFERENTIAL_POPULATION_DIVISOR) / REFERENTIAL_LOG2_SCALE)
}

/**
 * A thing that can be ranked referentially.
 *
 * Both fields are optional.
 * A candidate with neither field sorts last.
 *
 * That position matches the existing order for a candidate with no population.
 */
export interface ReferentiallyRankable {
	referential?: number | null
	population?: number | null
}

/**
 * The ranking comparator: referential desc, raw population desc as the tiebreak.
 *
 * Negative when `a` outranks `b`, so it drops straight into `Array#sort`.
 *
 * The population tiebreak makes "rank by referential" and "rank by population" produce the same order.
 * {@link referentialFromPopulation} increases strictly below {@link REFERENTIAL_SATURATION_POPULATION}.
 * The score stays constant above that population.
 *
 * Without the tiebreak this comparator would silently re-order the world's
 * largest cities: a real behavior change.
 * The D-rule would catch it.
 *
 * The comparator has no encyclopedic-importance parameter because §2 forbids ranking by that value.
 * This interface prevents callers from expressing that ranking.
 */
export function compareReferential(a: ReferentiallyRankable, b: ReferentiallyRankable): number {
	return (b.referential ?? 0) - (a.referential ?? 0) || (b.population ?? 0) - (a.population ?? 0)
}
