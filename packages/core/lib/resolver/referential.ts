/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The REFERENTIAL score and its comparator — the ranking half of the two-score split (ROAD_TO_V9 §2
 *   R1, ratified 2026-08-06).
 *
 *   THE POLICY. "The importance of a knowledge-base article is not the probability that this is the
 *   place the user means." A geocoder ranks by REFERENTIAL likelihood; encyclopedic importance is
 *   carried as data and is never a ranking key. Saint-Denis is the canonical case: the
 *   Seine-Saint-Denis suburb (pop 96,128) carries encyclopedic 0.1173 and the Aude hamlet (pop 418)
 *   carries 0.5683, so encyclopedic ranking inverts the answer every user means, by 4.8x.
 *
 *   WHY THIS LIVES IN `@mailwoman/core`. Three packages need the same number and must not drift:
 *   `@mailwoman/resolver` (backend-agnostic — it cannot import a backend),
 *   `@mailwoman/resolver-wof-sqlite` (the gazetteer schema + both lookups), and the FST builder that
 *   stamps referential scores into the decode-bias artifact. `core/resolver/types.ts` already owns the
 *   `ResolvedPlace` contract these three share, so the score that contract carries belongs beside it.
 */

/**
 * Population divisor in {@link referentialFromPopulation}. A 1,000-person place scores `log2(2)/14` — the curve starts
 * counting at the scale where WOF actually records population.
 */
export const REFERENTIAL_POPULATION_DIVISOR = 1000

/**
 * Log2 denominator in {@link referentialFromPopulation}. 14 puts the ceiling at `2^14 · 1000` people.
 */
export const REFERENTIAL_LOG2_SCALE = 14

/**
 * The population at which {@link referentialFromPopulation} saturates at exactly 1.0: `(2^14 − 1) · 1000` = 16,383,000.
 *
 * Required, not trivia. Above this the score CLAMPS, so two megacities that population would order (Tokyo ~37 M vs
 * Delhi ~33 M) tie at 1.0. Any ranking keyed on referential alone must break that tie on raw population to stay
 * ordering-identical to the population-first path — which is exactly what {@link compareReferential} does, and why it
 * exists rather than a bare subtraction at each call site.
 */
export const REFERENTIAL_SATURATION_POPULATION = (2 ** REFERENTIAL_LOG2_SCALE - 1) * REFERENTIAL_POPULATION_DIVISOR

/**
 * Population → referential likelihood in [0, 1].
 *
 * `min(1, log2(1 + pop/1000) / 14)` — the formula the FST builder has used for its population fallback since the FST
 * shipped, and the one `gazetteer importance` used for its fallback rows. It is defined ONCE here so the decode-bias
 * artifact's values, the gazetteer's `referential` column, and the resolver's ranking key are the same number by
 * construction rather than by three matching copies.
 *
 * MEANING OF ZERO: an absent population row and a recorded population of 0 both return 0, and 0 means "no population
 * evidence" — the ranking treats it as no boost, never a penalty. WOF carries population for roughly 15% of localities,
 * so absence is the common case and must stay cheap.
 */
export function referentialFromPopulation(population: number | null | undefined): number {
	if (population === null || population === undefined || population <= 0) return 0

	return Math.min(1, Math.log2(1 + population / REFERENTIAL_POPULATION_DIVISOR) / REFERENTIAL_LOG2_SCALE)
}

/**
 * A thing that can be ranked referentially. Both fields optional — a candidate with neither sorts last, which is the
 * same place a candidate with no population has always sorted.
 */
export interface ReferentiallyRankable {
	referential?: number
	population?: number
}

/**
 * The ranking comparator: referential DESC, raw population DESC as the tiebreak. Negative when `a` outranks `b`, so it
 * drops straight into `Array#sort`.
 *
 * The population tiebreak is not a hedge — it is what makes "rank by referential" and "rank by population" the SAME
 * ORDER on every input, because {@link referentialFromPopulation} is strictly increasing below
 * {@link REFERENTIAL_SATURATION_POPULATION} and constant above it. Without the tiebreak this comparator would silently
 * re-order the world's largest cities: a real behavior change, and the one the D-rule would catch.
 *
 * Encyclopedic importance is deliberately not a parameter. Ranking by it is the thing §2 forbids, and a comparator that
 * cannot express it is a stronger guarantee than a comment asking nobody to.
 */
export function compareReferential(a: ReferentiallyRankable, b: ReferentiallyRankable): number {
	return (b.referential ?? 0) - (a.referential ?? 0) || (b.population ?? 0) - (a.population ?? 0)
}
