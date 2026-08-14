/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Bounded cross-country PRIMARY-NAME preference over a population-ordered candidate row set — the
 *   `is_primary` ranking signal, PURE and platform-free so the Node candidate lookup
 *   (`candidate-lookup.ts`) and the browser twin (`docs/src/shared/httpvfs-resolver.ts`) rank with the
 *   SAME function rather than two copies that drift (the #861 server↔demo parity contract).
 *
 *   Only type imports and arithmetic live here: anything with a `node:` import stays out.
 */

import type { CandidateTable } from "./candidate-schema.ts"

/**
 * The row shape the re-rank needs. `is_primary` is optional: a reader over an artifact vintage that predates the column
 * omits it from the SELECT, no row reads as primary, and the re-rank no-ops by construction — the exact degradation the
 * browser reader's vintage guard relies on.
 */
export type PrimaryPreferenceRow = Pick<CandidateTable, "neg_rank" | "country_id"> &
	Partial<Pick<CandidateTable, "is_primary">>

/**
 * Bounded PRIMARY-NAME preference across a CROSS-COUNTRY name collision (the `is_primary` ranking signal).
 *
 * The raw candidate order is population-first (`neg_rank ASC`) and treats an ALIAS row (a place's alt-name / exonym,
 * `is_primary=0`) and a PRIMARY-name row (`is_primary=1`) on equal footing. So a foreign place whose transliterated
 * exonym coincidentally normalizes to a query — Changchun CN stores the Turkish exonym "Çançun" (`name_key="cancun"`),
 * 4.19 M pop — outranks the PRIMARY-name place the query actually means (Cancún MX, 0.89 M pop). This penalty makes a
 * same-key alias have to clear a population MARGIN over a foreign primary before it wins.
 *
 * It is deliberately NOT a dominant sort key (no `ORDER BY is_primary DESC`, which would make every primary outrank
 * every alias and break the alt-names users depend on — "NYC"→New York, "LA"→Los Angeles, "Frisco"→San Francisco). Two
 * bounds keep it a soft prior:
 *
 * 1. **Cross-country only.** The penalty applies to an alias ONLY when the top-population primary sharing the key is in a
 *    DIFFERENT country. A SAME-country nickname contest (San Francisco's alias "Frisco" vs the primary Frisco, TX —
 *    both US) is left on pure population, so the legitimate alias still wins.
 * 2. **Population-bounded.** The penalty is {@link PRIMARY_PREFERENCE_LOG10} in log10-population units — an alias must be
 *    at least 10x more populous than the foreign primary to still win. So a genuinely dominant alias keeps winning
 *    ("Los Angeles" over La, Ghana — gap 1.6; "Las Vegas" over Vegas, Cuba — gap 2.4) while a near-tie coincidental
 *    collision defers to the primary (Cancún over Changchun — gap 0.7).
 */
export const PRIMARY_PREFERENCE_LOG10 = 1

/**
 * Over-fetch cap for {@link rankByPrimaryPreference}: the candidate rows for one `name_key` (all same-name places
 * worldwide) are re-ranked in-process, so the probe fetches this many (population-ordered) before the re-rank rather
 * than the caller's small `limit`, ensuring the intended primary isn't cut below the fold by a cluster of more-populous
 * foreign aliases. Bounded and small — a single contiguous B-tree scan.
 */
export const RERANK_FETCH = 64

/**
 * A candidate row annotated with the {@link rankByPrimaryPreference} effective rank + the exact-tier demotion flag.
 */
export type RankedRow<R> = R & {
	/**
	 * `neg_rank` plus the bounded cross-country alias penalty — the value the row is ORDERED by, and the base the emitted
	 * `prominence` is derived from (so the resolver walk's `prominence ?? score` sort, `resolve.ts`, agrees with this
	 * order; the raw `score`/`neg_rank` is left intact for the walk's `minWinningScore` gate).
	 */
	effectiveNegRank: number
	/**
	 * True when this row is a cross-country alias that LOST the bounded population contest to the same-key primary — a
	 * coincidental foreign exonym (Changchun's "Çançun" for "Cancun"). Such a row is dropped out of the exact-match tier
	 * (`exactMatch=false`) so the resolver walk's country pin — the model's `anchorPosterior`, which "never crosses the
	 * exact/partial boundary" (`resolve.ts`) — can't ride a spurious posterior (CN 0.86 for "Cancun") back over the
	 * primary. Only the LOSING foreign alias is demoted; a dominant alias (Los Angeles over La, Ghana) keeps its exact
	 * tier, and a same-country nickname (San Francisco's "Frisco") is never touched.
	 */
	demoted: boolean
	/**
	 * True when this row came from the TYPO-CORRECTOR tier — the FTS5-trigram fallback that fires only after the exact
	 * and qualifier-strip probes both missed. Such a row answers a query the gazetteer does not contain, so it is a fuzzy
	 * match by construction and must not claim `exactMatch` (#17). Recall is unaffected: the row is still returned, still
	 * ranked, still resolvable — it just stops asserting a match quality it does not have, which is what the FTS backend
	 * has always done and what every `exactMatch`-filtering consumer assumed.
	 */
	fuzzy?: boolean
}

/**
 * Bounded cross-country primary-name preference (see {@link PRIMARY_PREFERENCE_LOG10}). Pure + total-ordered so
 * `candidate-lookup.test.ts` can exercise it on synthetic rows. `rows` arrive population-ordered (`neg_rank ASC`); an
 * alias (`is_primary=0`) is pushed back by `delta` in log10-population units ONLY when the top-population primary
 * sharing the key is in a different country, and is `demoted` out of the exact tier when that penalty leaves it BEHIND
 * the primary. Returns the top `limit` after the re-rank, each annotated.
 */
export function rankByPrimaryPreference<R extends PrimaryPreferenceRow>(
	rows: readonly R[],
	limit: number,
	delta = PRIMARY_PREFERENCE_LOG10
): Array<RankedRow<R>> {
	// The primary the alias actually competes with for the top slot: highest population (min neg_rank). Undefined
	// when the set has no primary → nothing to prefer, penalty is 0, order stays population-first (today's behavior).
	let topPrimary: R | undefined

	for (const r of rows) {
		if (r.is_primary === 1 && (topPrimary == null || r.neg_rank < topPrimary.neg_rank)) {
			topPrimary = r
		}
	}

	const topCountry = topPrimary?.country_id

	// A cross-country alias (different country than the top primary) is penalized; it is DEMOTED when even after — i.e.
	// the penalty leaves its effective rank behind the primary's raw rank (it lost the bounded population contest).
	const isCrossCountryAlias = (r: R): boolean =>
		typeof topCountry === "number" && r.is_primary !== 1 && r.country_id !== topCountry

	const annotate = (r: R): RankedRow<R> => {
		const penalized = isCrossCountryAlias(r)
		const effectiveNegRank = r.neg_rank + (penalized ? delta : 0)

		return { ...r, effectiveNegRank, demoted: penalized && effectiveNegRank > topPrimary!.neg_rank }
	}

	return (
		rows
			.map((r, i) => ({ row: annotate(r), i }))
			// Effective rank ASC; ties keep population order, then original index (stable).
			// oxlint-disable-next-line unicorn/no-array-sort -- sorts a freshly-built array; toSorted would double-allocate on a hot path
			.sort((a, b) => a.row.effectiveNegRank - b.row.effectiveNegRank || a.row.neg_rank - b.row.neg_rank || a.i - b.i)
			.slice(0, limit)
			.map((x) => x.row)
	)
}
