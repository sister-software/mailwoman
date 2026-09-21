/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Bounded cross-country primary-name preference over a population-ordered candidate row set — the
 *   `is_primary` ranking signal, pure and platform-free so the Node candidate lookup
 *   (`candidate-lookup.ts`) and the browser twin (`packages/resolver-wof-wasm/lib/httpvfs/resolver.ts`) rank with
 *   the same function rather than two copies that drift (the #861 server↔browser parity interface).
 *
 *   Only type imports and arithmetic live here: anything with a `node:` import stays out.
 */

import type { CandidateTable } from "#candidate/schema"

/**
 * The row shape the re-rank needs. `is_primary` is optional: a reader over an artifact vintage
 * that predates the column omits it from the select, no row reads as primary, and the re-rank
 * no-ops by construction — the exact degradation the browser reader's vintage guard relies on.
 */
export type PrimaryPreferenceRow = Pick<CandidateTable, "neg_rank" | "country_id"> &
	Partial<Pick<CandidateTable, "is_primary" | "placetype_id" | "population" | "name_role">>

/**
 * Bounded primary-name preference across a cross-country name collision (the `is_primary` ranking signal).
 *
 * The raw candidate order is population-first (`neg_rank ASC`) and treats an
 * alias row (a place's alt-name / exonym, `is_primary=0`) and a primary-name row
 * (`is_primary=1`) on equal footing. So a foreign place whose transliterated exonym
 * coincidentally normalizes to a query — Changchun CN stores the Turkish exonym
 * "Çançun" (`name_key="cancun"`), 4.19 M pop — outranks the primary-name place the
 * query actually means (Cancún MX, 0.89 M pop). This penalty makes a same-key alias
 * have to clear a population margin over a foreign primary before it wins.
 *
 * It is deliberately not a dominant sort key (no `order BY is_primary desc`, which would make
 * every primary outrank every alias and break the alt-names users depend on — "NYC"→New York,
 * "LA"→Los Angeles, "Frisco"→San Francisco). Two bounds keep it a soft prior:
 *
 * 1. **Cross-country only.** The penalty applies to an alias only when the top-population primary
 *    sharing the key is in a different country. A same-country nickname contest
 *    (San Francisco's alias "Frisco" vs the primary Frisco, TX — both US) is left
 *    on pure population, so the legitimate alias still wins.
 * 2. **Population-bounded.** The penalty is {@link PRIMARY_PREFERENCE_LOG10} in
 *    log10-population units — an alias must be at least 10x more populous than the
 *    foreign primary to still win. So a genuinely dominant alias keeps winning
 *    ("Los Angeles" over La, Ghana — gap 1.6; "Las Vegas" over Vegas, Cuba — gap 2.4) while a
 *    near-tie coincidental collision defers to the primary (Cancún over Changchun — gap 0.7).
 */
export const PRIMARY_PREFERENCE_LOG10 = 1

/**
 * The placetype the seat preference promotes: the populated-place tier a district
 * duplicate shares its name and its population with. Named rather than inlined
 * because narrowing the term to this one tier is what keeps it off the region/county
 * and locality/neighbourhood contests — see `rankByPrimaryPreference` for the measurement.
 */
const SEAT_PLACETYPE = "locality"

/**
 * Over-fetch cap for {@link rankByPrimaryPreference}: the candidate rows for one `name_key`
 * (all same-name places worldwide) are re-ranked in-process, so the probe fetches this
 * many (population-ordered) before the re-rank rather than the caller's small `limit`,
 * ensuring the intended primary isn't pushed below the fold by a cluster of more-populous
 * foreign aliases. Bounded and small — a single contiguous B-tree scan.
 */
export const RERANK_FETCH = 64

/**
 * A candidate row annotated with the {@link rankByPrimaryPreference} effective
 * rank + the exact-tier demotion flag.
 */
export type RankedRow<R> = R & {
	/**
	 * `neg_rank` plus the bounded cross-country alias penalty — the value the
	 * row is ordered by, and the base the emitted `prominence` is derived from
	 * (so the resolver walk's `prominence ?? score` sort, `resolve.ts`, agrees with this order.
	 * the raw `score`/`neg_rank` is left intact for the walk's `minWinningScore` floor).
	 */
	effectiveNegRank: number
	/**
	 * True when this row is a cross-country alias that lost the bounded population contest to
	 * the same-key primary — a coincidental foreign exonym (Changchun's "Çançun" for "Cancun").
	 * Such a row is dropped out of the exact-match tier (`exactMatch=false`)
	 * so the resolver walk's country pin — the model's `anchorPosterior`, which "never
	 * crosses the exact/partial boundary" (`resolve.ts`) — can't ride a spurious posterior
	 * (CN 0.86 for "Cancun") back over the primary. Only the losing foreign alias is
	 * demoted. a dominant alias (Los Angeles over La, Ghana) keeps its exact tier,
	 * and a same-country nickname (San Francisco's "Frisco") is never touched.
	 */
	demoted: boolean
	/**
	 * True when this row came from the typo-corrector tier — the FTS5-trigram fallback
	 * that fires only after the exact and qualifier-strip probes both missed.
	 * Such a row answers a query the gazetteer does not contain, so it is
	 * a fuzzy match by construction and must not claim `exactMatch` (#17).
	 * Recall is unaffected: the row is still returned, still ranked, still resolvable —
	 * it just stops asserting a match quality it does not have, which is what the FTS
	 * backend has always done and what every `exactMatch`-filtering consumer assumed.
	 */
	fuzzy?: boolean
	/**
	 * The admin-containment verdict (#1717 stage 2), stamped by `candidate-lookup.ts`
	 * when the query carried a `regionQualifier` and the artifact carries the ancestors sidecar —
	 * the `fuzzy` precedent: a lookup-tier annotation declared on the shared row shape.
	 * Tri-state like `ResolvedPlace.containedByQualifier`: absent means the question
	 * was never asked, never "not contained".
	 */
	containedByQualifier?: boolean
	/**
	 * The #1882 exemption's firing mark (#1893): this row would have taken the
	 * cross-country alias penalty and `exemptVariantAliases` prevented it.
	 * Present only when the exemption changed this row's treatment. absent on every row it
	 * merely inspected — an in-country variant, a primary, a set with no foreign top primary.
	 * The winner-level receipt downstream (`mechanism_fired_on.variant_alias_exemption`)
	 * counts this mark only when it survives onto the selected candidate.
	 */
	variantExempted?: true
}

/**
 * Bounded cross-country primary-name preference (see {@link PRIMARY_PREFERENCE_LOG10}).
 * Pure + total-ordered so `candidate-lookup.test.ts` can exercise it on synthetic rows.
 * `rows` arrive population-ordered (`neg_rank ASC`); an alias (`is_primary=0`) is pushed
 * back by `delta` in log10-population units only when the top-population primary sharing the
 * key is in a different country, and is `demoted` out of the exact tier when that penalty
 * leaves it behind the primary. Returns the top `limit` after the re-rank, each annotated.
 *
 * `placetypes` (the artifact's own `placetype_codes` map) enables the last tiebreak,
 * the seat preference: when `effectiveNegRank` and raw `neg_rank` both tie —
 * two same-key rows population cannot separate at all — a
 * {@link SEAT_PLACETYPE} row carrying a real population outranks every other placetype. Omit the map and every row
 * scores 0, the term cancels, and the order is exactly the population-then-scan-order it was before.
 *
 * The tie it exists for is a duplicate rather than a contest.
 * A district and its identically-named seat town are stored as two rows carrying
 * the same population, so `neg_rank` is equal to the bit and `referential`
 * follows it (`referentialFromPopulation` is a pure function of population).
 * Turkey's `Of` is the measured case — locality 8114738869649 and its parent county
 * 8837168432019 both hold population 44212 — and 358 locality/parent-county pairs across 15
 * countries share the shape in `admin-global-priority.db` (TR 162, CA 77, US 47, HR 24, do 14).
 * Without the term their order is whatever the scan hands the sorter.
 *
 * Where the term decides, and where IT cannot (#1729). It binds inside `findPlace`,
 * so it orders every row set that actually contains the tie — but the resolver walk's
 * probes all carry a placetype filter, and `PLACETYPE_FILTER_GROUPS` (core/resolver) never
 * mixes `locality` with `county`: the `Of`-shape locality/county pair is partitioned
 * before this ranker runs, the locality probe fetches one row, and the walk's own
 * `locality` request selects the seat by construction — the same winner, decided upstream.
 * The tie that reaches an end-to-end answer through this term is the IN-group residue:
 * a locality/localadmin (or borough) duplicate whose `importance` values also tie.
 * Downstream the resolver re-sorts by importance (`resolver/toponym-prior.ts`)
 * but is stable on equal keys, so the order stamped here is the order
 * that answers — inverting this term moves bare `Pu-cheng-hsien` 1,100 km
 * (locality Pucheng over the 浦城县 localadmin, identical population and importance).
 * Where importance separates the pair, the fame prior overrides by design. a probe
 * with no placetype filter (the browser cascade's last resort, the dev lookup tools)
 * presents the full tie and this term is all that breaks it.
 *
 * Both conditions are required, and a plain "finer placetype wins" measured wrong
 * before this shape was settled: it moved the top slot on 11,377 keys in `candidate.db`,
 * of which only 722 were the seat/district duplicate. The rest were contests between
 * genuinely distinct places that merely tie — 2,885 `locality → neighbourhood`
 * (a bare city name losing to a same-named hood), 2,973 `region → county`,
 * 2,662 `postalcode → locality` — and 7,179 of the 11,377 sat at population 0, where a
 * tie means no evidence rather than equal evidence. Requiring a real population keeps
 * the term off every no-evidence tie. promoting the populated-place tier specifically,
 * rather than whatever is finer, keeps it off the admin-tier and hood contests.
 * It can never reach a pair population separates: it does not override a population gap,
 * it replaces an undetermined order with a stated one.
 */
export function rankByPrimaryPreference<R extends PrimaryPreferenceRow>(
	rows: readonly R[],
	limit: number,
	delta = PRIMARY_PREFERENCE_LOG10,
	placetypes?: ReadonlyMap<number, string>,
	exemptVariantAliases = false
): Array<RankedRow<R>> {
	// The primary the alias actually competes with for the top slot: highest population
	// (min neg_rank). Undefined when the set has no primary → nothing to prefer,
	// penalty is 0, order stays population-first (today's behavior).
	let topPrimary: R | undefined

	for (const r of rows) {
		if (r.is_primary === 1 && (topPrimary == null || r.neg_rank < topPrimary.neg_rank)) {
			topPrimary = r
		}
	}

	const topCountry = topPrimary?.country_id

	// A cross-country alias (different country than the top primary) is penalized. it
	// is demoted when even after — i.e. the penalty leaves its effective rank behind
	// the primary's raw rank (it lost the bounded population contest).
	//
	// #1882 exemption (opt-in): a `name_role = 'variant'` alias is the holder's own primary name in another
	// orthography (`Брэст` → `brest`, `George Town` → `georgetown` — the build's own-name detector),
	// so the query is naming that place rather than colliding with it. the penalty
	// exists for the coincidental-collision
	// class ("Çançun"/`cancun`), which the detector's measured threshold keeps un-stamped. An artifact
	// predating the role column carries no 'variant' rows, so the flag no-ops there by construction.
	const wouldPenalize = (r: R): boolean =>
		typeof topCountry === "number" && r.is_primary !== 1 && r.country_id !== topCountry

	const isCrossCountryAlias = (r: R): boolean =>
		wouldPenalize(r) && !(exemptVariantAliases && r.name_role === "variant")

	const annotate = (r: R): RankedRow<R> => {
		const penalized = isCrossCountryAlias(r)
		const effectiveNegRank = r.neg_rank + (penalized ? delta : 0)

		// The firing mark (#1893): this row would have taken the cross-country penalty
		// and the exemption prevented it — conditions the winner-level receipt needs,
		// computed where the decision is made. A variant row that was in-country, primary,
		// or keyed under a set with no foreign primary never fired, and stays unmarked.
		const exempted = !penalized && exemptVariantAliases && r.name_role === "variant" && wouldPenalize(r)

		return {
			...r,
			effectiveNegRank,
			demoted: penalized && effectiveNegRank > topPrimary!.neg_rank,
			...(exempted ? { variantExempted: true as const } : {}),
		}
	}

	// 1 for a populated-place row that can be a district's seat, 0 for everything else —
	// no code map, no placetype on the row, an id the map does not carry, a placetype that
	// is not the seat tier, or no recorded population. Every row scoring 0 cancels the term,
	// leaving exactly the population-then-scan-order the sort had before it existed.
	const seatPreference = (r: R): number =>
		placetypes != null &&
		typeof r.placetype_id === "number" &&
		typeof r.population === "number" &&
		r.population > 0 &&
		placetypes.get(r.placetype_id) === SEAT_PLACETYPE
			? 1
			: 0

	// 1 for a primary-name row whose prominence is unmeasured (population 0), 0 for everything else.
	// Two unmeasured rows tie on `neg_rank`, and that tie used to fall through to
	// scan order — the B-tree's `spr_id`, which is no evidence about either place.
	// A row that is named X ranks ahead of one merely also-known-as X when nothing else separates
	// them: Taiwan's 溪州鄉 township row (its own name, unmeasured) over the village 溪洲 30 km away
	// that carries `溪州鄉` as an alias (unmeasured), which the lower WOF id had been winning.
	// Populated ties are untouched — a populated alias ("NYC") never reaches this term,
	// and two populated rows keep the order they had.
	const unmeasuredPrimary = (r: R): number =>
		r.is_primary === 1 && typeof r.population === "number" && r.population === 0 ? 1 : 0

	return (
		rows
			.map((r, i) => ({ row: annotate(r), i }))
			// Effective rank ASC. ties keep population order, then the seat preference desc, then the primary name
			// among unmeasured rows, then original index (stable).
			// oxlint-disable-next-line unicorn/no-array-sort -- sorts a freshly-built array. toSorted would double-allocate on a hot path
			.sort(
				(a, b) =>
					a.row.effectiveNegRank - b.row.effectiveNegRank ||
					a.row.neg_rank - b.row.neg_rank ||
					seatPreference(b.row) - seatPreference(a.row) ||
					unmeasuredPrimary(b.row) - unmeasuredPrimary(a.row) ||
					a.i - b.i
			)
			.slice(0, limit)
			.map((x) => x.row)
	)
}
