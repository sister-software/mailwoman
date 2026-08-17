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
	Partial<Pick<CandidateTable, "is_primary" | "placetype_id" | "population">>

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
 * The placetype the seat preference promotes: the populated-place tier a district duplicate shares its name and its
 * population with. Named rather than inlined because narrowing the term to this ONE tier is what keeps it off the
 * region/county and locality/neighbourhood contests — see `rankByPrimaryPreference` for the measurement.
 */
const SEAT_PLACETYPE = "locality"

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
 *
 * `placetypes` (the artifact's own `placetype_codes` map) enables the LAST tiebreak, the SEAT preference: when
 * `effectiveNegRank` and raw `neg_rank` both tie — two same-key rows population cannot separate at all — a
 * {@link SEAT_PLACETYPE} row carrying a real population outranks every other placetype. Omit the map and every row
 * scores 0, the term cancels, and the order is exactly the population-then-scan-order it was before.
 *
 * The tie it exists for is a DUPLICATE, not a contest. A district and its identically-named seat town are stored as two
 * rows carrying the SAME population, so `neg_rank` is equal to the bit and `referential` follows it
 * (`referentialFromPopulation` is a pure function of population). Turkey's `Of` is the measured case — locality
 * 8114738869649 and its parent county 8837168432019 both hold population 44212 — and 358 locality/parent-county pairs
 * across 15 countries share the shape in `admin-global-priority.db` (TR 162, CA 77, US 47, HR 24, DO 14). Without the
 * term their order is whatever the scan hands the sorter.
 *
 * WHERE THE TERM DECIDES, AND WHERE IT CANNOT (#1729). It binds inside `findPlace`, so it orders every row set that
 * actually CONTAINS the tie — but the resolver walk's probes all carry a placetype filter, and
 * `PLACETYPE_FILTER_GROUPS` (core/resolver) never mixes `locality` with `county`: the `Of`-shape locality/county pair
 * is PARTITIONED before this ranker runs, the locality probe fetches one row, and the walk's own `locality` request
 * selects the seat by construction — the same winner, decided upstream. The tie that reaches an end-to-end answer
 * through this term is the IN-GROUP residue: a locality/localadmin (or borough) duplicate whose `importance` values
 * also tie. Downstream the resolver re-sorts by importance (`resolver/toponym-prior.ts`) but is stable on equal keys,
 * so the order stamped here is the order that answers — inverting this term moves bare `Pu-cheng-hsien` 1,100 km
 * (locality Pucheng over the 浦城县 localadmin, identical population and importance). Where importance separates the pair,
 * the fame prior overrides by design; a probe with NO placetype filter (the browser cascade's last resort, the dev
 * lookup tools) presents the full tie and this term is all that breaks it.
 *
 * BOTH GATES ARE LOAD-BEARING, and a plain "finer placetype wins" measured wrong before this shape was settled: it
 * moved the top slot on 11,377 keys in `candidate.db`, of which only 722 were the seat/district duplicate. The rest
 * were contests between genuinely distinct places that merely tie — 2,885 `locality → neighbourhood` (a bare city name
 * losing to a same-named hood), 2,973 `region → county`, 2,662 `postalcode → locality` — and 7,179 of the 11,377 sat at
 * population 0, where a tie means NO EVIDENCE rather than equal evidence. Requiring a real population keeps the term
 * off every no-evidence tie; promoting the populated-place tier specifically, rather than whatever is finer, keeps it
 * off the admin-tier and hood contests. It can never reach a pair population separates: it does not override a
 * population gap, it replaces an undetermined order with a stated one.
 */
export function rankByPrimaryPreference<R extends PrimaryPreferenceRow>(
	rows: readonly R[],
	limit: number,
	delta = PRIMARY_PREFERENCE_LOG10,
	placetypes?: ReadonlyMap<number, string>
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

	// 1 for a populated-place row that can BE a district's seat, 0 for everything else — no code map, no
	// placetype on the row, an id the map does not carry, a placetype that is not the seat tier, or no
	// recorded population. Every row scoring 0 cancels the term, leaving exactly the
	// population-then-scan-order the sort had before it existed.
	const seatPreference = (r: R): number =>
		placetypes != null &&
		typeof r.placetype_id === "number" &&
		typeof r.population === "number" &&
		r.population > 0 &&
		placetypes.get(r.placetype_id) === SEAT_PLACETYPE
			? 1
			: 0

	return (
		rows
			.map((r, i) => ({ row: annotate(r), i }))
			// Effective rank ASC; ties keep population order, then the seat preference DESC, then original
			// index (stable).
			// oxlint-disable-next-line unicorn/no-array-sort -- sorts a freshly-built array; toSorted would double-allocate on a hot path
			.sort(
				(a, b) =>
					a.row.effectiveNegRank - b.row.effectiveNegRank ||
					a.row.neg_rank - b.row.neg_rank ||
					seatPreference(b.row) - seatPreference(a.row) ||
					a.i - b.i
			)
			.slice(0, limit)
			.map((x) => x.row)
	)
}
