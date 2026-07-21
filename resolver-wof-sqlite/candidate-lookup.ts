/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Node-side {@link PlaceLookup} over the byte-range CANDIDATE table (`build-candidate.ts`) — the
 *   SAME gazetteer the browser demo resolves against ({@link WOFCandidateTableLookup} in
 *   `docs/src/shared/httpvfs-resolver.ts`), but reading a LOCAL `candidate.db` via `node:sqlite`
 *   instead of sql.js-httpvfs. This is what makes the server/CLI resolver match the demo: one
 *   lookup surface, one artifact, one ranking.
 *
 *   The query is a single contiguous probe on the `WITHOUT ROWID` B-tree keyed `(name_key,
 *   country_id, region_id, placetype_id, neg_rank, spr_id)`. `name_key` is the SHARED
 *   {@link normalizeLocalityForKey} (build- and query-consistent), each row is denormalized (display
 *   `name`, centroid, bbox), and population rank is precomputed into `neg_rank` — so the result is
 *   POPULATION-FIRST and COUNTRY-AGNOSTIC (when no `country` filter is given), exactly like the
 *   demo. That's the deliberate divergence from {@link WOFSqlitePlaceLookup}'s FTS/bm25 ranking: a
 *   bare "Moscow" resolves to the 10.4 M-pop Russian city, not whichever same-name US township bm25
 *   floats to the top.
 *
 *   Disambiguation rides the same mechanism the cascade already uses: a parsed region resolves to its
 *   stored bbox and the locality query is point-in-bbox-filtered on the candidate centroid (the
 *   `bbox` field on {@link FindPlaceQuery}).
 */

import { DatabaseSync } from "node:sqlite"

import { expandPlacetypeFilter } from "@mailwoman/resolver"

import { CANDIDATE_FTS_TABLE } from "./candidate-fts.ts"
import type { CandidateTable, CountryCodeTable, PlacetypeCodeTable } from "./candidate-schema.ts"
import { haversineKm } from "./geo.ts"
import { trigramJaccard } from "./lookup.ts"
import { POSTAL_CITY_CANDIDATE_TABLE, type PostalCityCandidateTable } from "./postal-city-candidate-schema.ts"
import { hasTable } from "./sqlite-utils.ts"
import { normalizeLocalityForKey, stripLocalityQualifier } from "./street-normalize.ts"
import type { FindPlaceQuery, PlaceCandidate, PlaceLookup, WOFPlacetype } from "./types.ts"

export interface WOFCandidateTableLookupOpts {
	/** Path to a `candidate.db` built by `build-candidate.ts`. Opened read-only. */
	databasePath?: string
	/** Pre-opened handle (tests / shared connections). Mutually exclusive with `databasePath`. */
	database?: DatabaseSync
}

/**
 * The candidate columns this lookup probes — a typed projection of the SHARED {@link CandidateTable}, so a column rename
 * in `build-candidate` (the writer) is a compile error here (the reader).
 */
type CandidateRow = Pick<
	CandidateTable,
	| "spr_id"
	| "name"
	| "country_id"
	| "placetype_id"
	| "latitude"
	| "longitude"
	| "min_lat"
	| "min_lon"
	| "max_lat"
	| "max_lon"
	| "neg_rank"
	| "is_primary"
>

/**
 * FTS5-trigram over-fetch before the trigram-Jaccard re-rank, and the minimum similarity to count as a fuzzy hit (below
 * it the trigram overlap is noise, e.g. unrelated same-trigram names). Tunable.
 */
const FUZZY_FETCH = 40
const FUZZY_MIN = 0.34

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
const PRIMARY_PREFERENCE_LOG10 = 1.0

/**
 * Over-fetch cap for {@link rankByPrimaryPreference}: the candidate rows for one `name_key` (all same-name places
 * worldwide) are re-ranked in-process, so the probe fetches this many (population-ordered) before the re-rank rather
 * than the caller's small `limit`, ensuring the intended primary isn't cut below the fold by a cluster of more-populous
 * foreign aliases. Bounded and small — a single contiguous B-tree scan.
 */
const RERANK_FETCH = 64

/** A candidate row annotated with the {@link rankByPrimaryPreference} effective rank + the exact-tier demotion flag. */
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
}

/**
 * Bounded cross-country primary-name preference (see {@link PRIMARY_PREFERENCE_LOG10}). Pure + total-ordered so
 * `candidate-lookup.test.ts` can exercise it on synthetic rows. `rows` arrive population-ordered (`neg_rank ASC`); an
 * alias (`is_primary=0`) is pushed back by `delta` in log10-population units ONLY when the top-population primary
 * sharing the key is in a different country, and is `demoted` out of the exact tier when that penalty leaves it BEHIND
 * the primary. Returns the top `limit` after the re-rank, each annotated.
 */
export function rankByPrimaryPreference<R extends Pick<CandidateRow, "neg_rank" | "is_primary" | "country_id">>(
	rows: readonly R[],
	limit: number,
	delta = PRIMARY_PREFERENCE_LOG10
): Array<RankedRow<R>> {
	// The primary the alias actually competes with for the top slot: highest population (min neg_rank). Undefined
	// when the set has no primary → nothing to prefer, penalty is 0, order stays population-first (today's behavior).
	let topPrimary: R | undefined

	for (const r of rows) {
		if (r.is_primary === 1 && (topPrimary === undefined || r.neg_rank < topPrimary.neg_rank)) {
			topPrimary = r
		}
	}

	const topCountry = topPrimary?.country_id
	// A cross-country alias (different country than the top primary) is penalized; it is DEMOTED when even after — i.e.
	// the penalty leaves its effective rank behind the primary's raw rank (it lost the bounded population contest).
	const isCrossCountryAlias = (r: R): boolean =>
		topCountry !== undefined && r.is_primary !== 1 && r.country_id !== topCountry
	const annotate = (r: R): RankedRow<R> => {
		const penalized = isCrossCountryAlias(r)
		const effectiveNegRank = r.neg_rank + (penalized ? delta : 0)

		return { ...r, effectiveNegRank, demoted: penalized && effectiveNegRank > topPrimary!.neg_rank }
	}

	return (
		rows
			.map((r, i) => ({ row: annotate(r), i }))
			// Effective rank ASC; ties keep population order, then original index (stable).
			.sort((a, b) => a.row.effectiveNegRank - b.row.effectiveNegRank || a.row.neg_rank - b.row.neg_rank || a.i - b.i)
			.slice(0, limit)
			.map((x) => x.row)
	)
}

/**
 * Unpadded character-trigrams of `s`, OR'd into an FTS5 trigram MATCH query (each quoted so FTS treats it as a literal
 * term). Returns "" when `s` is shorter than a trigram or yields no clean grams — the caller then skips the fuzzy
 * probe.
 */
function ftsTrigramQuery(s: string): string {
	const grams = new Set<string>()

	for (let i = 0; i + 3 <= s.length; i++) {
		const g = s.slice(i, i + 3)

		if (/^[\p{L}\p{N} ]{3}$/u.test(g)) {
			grams.add(g)
		}
	}

	return [...grams].map((g) => `"${g}"`).join(" OR ")
}

/**
 * Node {@link PlaceLookup} over `candidate.db`. Drop-in for {@link WOFSqlitePlaceLookup} in `createWOFResolver(backend)`
 * — same `findPlace` contract, population-first ranking.
 */
export class WOFCandidateTableLookup implements PlaceLookup {
	#db: DatabaseSync
	#ownsDB: boolean
	readonly #countryToID = new Map<string, number>()
	readonly #idToCountry = new Map<number, string>()
	readonly #placetypeToID = new Map<string, number>()
	readonly #idToPlacetype = new Map<number, string>()
	/**
	 * Prepared `(name_key, postcode)` probe for the #741 postal-city side-index — `undefined` when the
	 * `postal_city_candidate` table isn't present, so a candidate.db built without it is byte-stable.
	 */
	readonly #postalCityProbe: ReturnType<DatabaseSync["prepare"]> | undefined
	/**
	 * Prepared FTS5-trigram MATCH probe for the typo-tolerant fallback — `undefined` when the `candidate_fts` index isn't
	 * present, so a candidate.db built without it is byte-stable (the fuzzy path is skipped, exactly like today).
	 */
	readonly #ftsProbe: ReturnType<DatabaseSync["prepare"]> | undefined
	/**
	 * Prepared UNFILTERED existence probe (`name_key` present anywhere, ignoring country/placetype/bbox). Gates the fuzzy
	 * fallback: fuzzy is a TYPO corrector, so it engages only when the name doesn't exist in the gazetteer at all. A name
	 * that DOES exist but missed under the active filter is a filter miss (e.g. a placer misroute "Vienna, Austria"→IT),
	 * not a spelling miss — fuzzing it would scrape an unrelated same-country place and defeat the cascade's
	 * country-agnostic retry. Prepared only alongside `#ftsProbe`.
	 */
	readonly #nameKeyExistsProbe: ReturnType<DatabaseSync["prepare"]> | undefined

	constructor(opts: WOFCandidateTableLookupOpts) {
		if (opts.database) {
			this.#db = opts.database
			this.#ownsDB = false
		} else if (opts.databasePath) {
			this.#db = new DatabaseSync(opts.databasePath, { readOnly: true })
			this.#ownsDB = true
		} else {
			throw new Error("WOFCandidateTableLookup needs `databasePath` or `database`")
		}

		// The code tables are tiny (country/placetype dictionaries) — load them once at construction so
		// `findPlace` is a single B-tree probe with no dictionary round-trip.
		for (const r of this.#db.prepare("SELECT id, code FROM country_codes").all() as unknown as CountryCodeTable[]) {
			const code = String(r.code).toUpperCase()
			this.#countryToID.set(code, Number(r.id))
			this.#idToCountry.set(Number(r.id), code)
		}

		for (const r of this.#db
			.prepare("SELECT id, placetype FROM placetype_codes")
			.all() as unknown as PlacetypeCodeTable[]) {
			this.#placetypeToID.set(String(r.placetype), Number(r.id))
			this.#idToPlacetype.set(Number(r.id), String(r.placetype))
		}

		// #741 postal-city side-index: prepare the exact probe only if the table is present. Absent →
		// `#postalCityProbe` stays undefined → findPlace skips the postal-city path → byte-stable.
		if (hasTable(this.#db, POSTAL_CITY_CANDIDATE_TABLE)) {
			this.#postalCityProbe = this.#db.prepare(
				`SELECT spr_id, name, latitude, longitude FROM ${POSTAL_CITY_CANDIDATE_TABLE} WHERE name_key = ? AND postcode = ? LIMIT 1`
			)
		}

		// FTS5-trigram fuzzy fallback: prepare the MATCH probe only if the index is present (the unified
		// gazetteer carries it; an older candidate.db doesn't → the fuzzy path is skipped, byte-stable).
		if (hasTable(this.#db, CANDIDATE_FTS_TABLE)) {
			this.#ftsProbe = this.#db.prepare(
				`SELECT name_key FROM ${CANDIDATE_FTS_TABLE} WHERE ${CANDIDATE_FTS_TABLE} MATCH ? ORDER BY bm25(${CANDIDATE_FTS_TABLE}) LIMIT ?`
			)
			this.#nameKeyExistsProbe = this.#db.prepare("SELECT 1 FROM candidate WHERE name_key = ? LIMIT 1")
		}
	}

	/** Does this query want a locality-tier place? Postal-city aliases (#741) are all localities. */
	#wantsLocality(placetype: FindPlaceQuery["placetype"]): boolean {
		if (!placetype) return true
		const want = Array.isArray(placetype) ? placetype : [placetype]

		return expandPlacetypeFilter(want as readonly string[]).includes("locality")
	}

	async findPlace(query: FindPlaceQuery): Promise<PlaceCandidate[]> {
		let text = (query.text ?? "").trim()

		if (!text) return []

		// #920 name law, candidate-key edition: postcode rows are keyed by their whitespace-stripped
		// form at build (the GeoNames fold normalizes '624 66' → '62466'), so a postcode-typed query
		// strips internal whitespace before keying. Postcode-only — locality names keep their spaces.
		if ([query.placetype].flat().includes("postalcode")) {
			text = text.replace(/\s+/g, "")
		}
		const nameKey = normalizeLocalityForKey(text)

		if (!nameKey) return []

		// #741: postcode-keyed postal-city alias. An exact `(name_key, postcode)` hit resolves a
		// user-typed POSTAL city ("Antioch", 37013) to the geographic locality the postcode sits in
		// ("Nashville"), bypassing the population/region ranking that can't see the postcode. Gated on
		// the side-index being present, a postcode in the query, and a locality-tier request — so the
		// common (no-postcode / non-locality) path is untouched. A hit short-circuits: the postcode is
		// an exact, high-confidence disambiguator, so we return the single geographic locality.
		if (query.postcode && this.#postalCityProbe && this.#wantsLocality(query.placetype)) {
			const hit = this.#postalCityProbe.get(nameKey, query.postcode.trim()) as
				| Pick<PostalCityCandidateTable, "spr_id" | "name" | "latitude" | "longitude">
				| undefined

			if (hit) {
				return [
					{
						id: Number(hit.spr_id),
						name: String(hit.name ?? ""),
						placetype: "locality" as WOFPlacetype,
						country: query.country?.toUpperCase() ?? "",
						lat: Number(hit.latitude),
						lon: Number(hit.longitude),
						score: 1,
						exactMatch: true,
					},
				]
			}
		}

		const limit = Math.max(1, query.limit ?? 10)

		// Filter conds shared by the exact-key + strip-fallback probes (everything but name_key).
		const filters: string[] = []
		const filterParams: Array<string | number> = []

		if (query.country) {
			const cid = this.#countryToID.get(query.country.toUpperCase())

			if (cid === undefined) return [] // a country the candidate table doesn't carry
			filters.push("country_id = ?")
			filterParams.push(cid)
		}

		if (query.placetype) {
			// Shared placetype-equivalence expansion (a `locality` query must also reach borough /
			// localadmin). `postalcode` maps to no admin placetype here → empty → no rows.
			const want = Array.isArray(query.placetype) ? query.placetype : [query.placetype]
			const ids = expandPlacetypeFilter(want as readonly string[])
				.map((t) => this.#placetypeToID.get(t))
				.filter((v): v is number => v !== undefined)

			if (ids.length === 0) return []
			filters.push(`placetype_id IN (${ids.map(() => "?").join(",")})`)
			filterParams.push(...ids)
		}

		if (query.bbox) {
			const b = query.bbox
			filters.push("latitude BETWEEN ? AND ? AND longitude BETWEEN ? AND ?")
			filterParams.push(b.minLat, b.maxLat, b.minLon, b.maxLon)
		}

		// Region scope: when the cascade resolves a region and passes it down as `parentID` (the walk sets
		// `query.parentID = parentResolved.id`), the candidate build stamps each place's region-tier ancestor
		// id into `region_id` (build-candidate.ts `regionOf`), and that id equals the resolved region's WOF id
		// — so `region_id = parentID` scopes the probe to in-region rows. Without it a bare same-name probe is
		// population-first and "Springfield, IL" (parentID = Illinois) drops to the larger Springfield, MO.
		// Kept OUT of the shared `filters` so a region MISS falls back to the unscoped cascade below: a
		// country/non-region parent (no `region_id` match), a `region_id=0` row (place with no region
		// ancestor), or a wrong parent degrades to today's behavior — never worse, recall-safe by construction.
		const regionParentID = query.parentID ? query.parentID : undefined

		const probe = (nk: string, regionID: number | undefined): Array<RankedRow<CandidateRow>> => {
			const conds = ["name_key = ?", ...filters]
			const params: Array<string | number> = [nk, ...filterParams]

			if (regionID !== undefined) {
				conds.push("region_id = ?")
				params.push(regionID)
			}

			// Fetch population-ordered (the clustered-key order — a cheap ordered scan), over-fetching to
			// RERANK_FETCH so the bounded cross-country primary-preference re-rank (below) can promote the
			// intended primary even when a cluster of more-populous foreign aliases sits ahead of it. `is_primary`
			// + `country_id` feed that re-rank. A single-country probe (a country filter, or all rows same
			// country) re-ranks to the identical population order, so the common path is untouched.
			const sql =
				"SELECT spr_id, name, country_id, placetype_id, latitude, longitude, min_lat, min_lon, max_lat, max_lon, neg_rank, is_primary " +
				`FROM candidate WHERE ${conds.join(" AND ")} ORDER BY neg_rank ASC LIMIT ?`
			const fetched = this.#db.prepare(sql).all(...params, Math.max(limit, RERANK_FETCH)) as unknown as CandidateRow[]

			return rankByPrimaryPreference(fetched, limit)
		}

		// The exact → qualifier-strip → typo-fuzzy probe cascade, run at a fixed region scope. Region scoping
		// only tightens an already-population-first pick, so a region MISS re-runs the whole cascade unscoped
		// (below) rather than dropping a place that has no in-region row.
		const cascade = (regionID: number | undefined): Array<RankedRow<CandidateRow>> => {
			let rows = probe(nameKey, regionID)

			if (rows.length === 0) {
				// Query-side qualifier-strip fallback: an OA locality with a qualifier the gazetteer's
				// canonical name omits ("Lenk im Simmental" → "Lenk", "Roche VD"). Tried ONLY on an exact
				// miss; the cascade's region bbox disambiguates any base-name ambiguity.
				const strippedKey = normalizeLocalityForKey(stripLocalityQualifier(text))

				if (strippedKey && strippedKey !== nameKey) {
					rows = probe(strippedKey, regionID)
				}
			}

			// Typo-tolerant fallback (the unified gazetteer's fuzzy mode): an exact + strip miss may be a
			// misspelling the normalized key can't reach. FTS5-trigram fetches a loose set; we re-rank by
			// trigram-Jaccard (the admin backend's measure) and probe the best name_keys, so a typo resolves
			// the same on either backend. The country/placetype/bbox/region filters still apply via `probe`.
			// Skipped when the index is absent (byte-stable for an older candidate.db).
			//
			// Gate: only when the name doesn't exist in the gazetteer AT ALL (unfiltered). A name that exists
			// but missed under the active country/placetype/bbox filter is a FILTER miss, not a spelling miss
			// — fuzzing it scrapes an unrelated same-filter place ("Vienna, Austria" misrouted to IT would
			// pull a tiny Italian name_key near Siena) and masks the cascade's country-agnostic retry that
			// correctly lands population-first Vienna AT. The exact/strip probes already covered the real name.
			if (rows.length === 0 && this.#ftsProbe && this.#nameKeyExistsProbe && !this.#nameKeyExistsProbe.get(nameKey)) {
				const match = ftsTrigramQuery(nameKey)

				if (match) {
					const hits = this.#ftsProbe.all(match, FUZZY_FETCH) as unknown as Array<{ name_key: string }>
					const ranked = hits
						.map((h) => ({ nk: String(h.name_key), s: trigramJaccard(nameKey, String(h.name_key)) }))
						.filter((h) => h.s >= FUZZY_MIN)
						.sort((a, b) => b.s - a.s)
					const seen = new Set<string>()

					for (const h of ranked) {
						if (seen.has(h.nk)) continue
						seen.add(h.nk)
						rows.push(...probe(h.nk, regionID))

						if (rows.length >= limit) break
					}
					rows = rows.slice(0, limit)
				}
			}

			return rows
		}

		let rows = cascade(regionParentID)

		// Region-scope fallback: if scoping to the parent region found nothing across the whole cascade, retry
		// unscoped so a place with no in-region row (missing ancestry, or a country/non-region parent) still
		// resolves exactly as it does today. Only when a region scope was actually applied.
		if (rows.length === 0 && regionParentID !== undefined) {
			rows = cascade(undefined)
		}

		const candidates = rows.map((row): PlaceCandidate => {
			const hasBbox = row.min_lat != null && row.max_lat != null && row.min_lon != null && row.max_lon != null

			return {
				id: Number(row.spr_id),
				name: String(row.name ?? ""),
				placetype: (this.#idToPlacetype.get(Number(row.placetype_id)) ?? "") as WOFPlacetype,
				// Surfaced so the cascade can country-gate a postcode by the resolved locality (an ambiguous
				// international postcode like 10115 = Berlin DE AND New York US must not out-resolve the city).
				country: this.#idToCountry.get(Number(row.country_id)) ?? "",
				lat: Number(row.latitude),
				lon: Number(row.longitude),
				// `score` stays the RAW population rank (`-neg_rank`) — it feeds the resolver walk's absolute
				// `minWinningScore` gate (`resolve.ts`), which must see real prominence, never a penalized value.
				score: -Number(row.neg_rank),
				// `prominence` carries the bounded cross-country primary preference (the effective, penalty-adjusted
				// rank). The walk ORDERS candidates by `prominence ?? score` (`resolve.ts`), so this is what makes the
				// re-rank actually stick through resolution — without it the walk re-sorts by raw `score` and a
				// more-populous foreign alias (Changchun for "Cancun") wins back the node. Equals `score` for every
				// un-penalized row (primaries + same-country aliases), so the common ordering is unchanged.
				prominence: -Number(row.effectiveNegRank),
				// Every candidate row IS an exact normalized-name (or alias/abbrev) match — the cascade's exact tier
				// accepts alias-exact hits ("New York City" → New York) the same as canonical — EXCEPT a cross-country
				// alias that lost the bounded contest to a same-key primary (`demoted`): it drops to the partial tier so
				// the walk's country posterior can't cross back over the primary (see `RankedRow.demoted`).
				exactMatch: !row.demoted,
				...(hasBbox
					? {
							bbox: {
								minLat: Number(row.min_lat),
								maxLat: Number(row.max_lat),
								minLon: Number(row.min_lon),
								maxLon: Number(row.max_lon),
							},
						}
					: {}),
			}
		})

		// Proximity re-rank (#938): with bias hints (the demo's map viewport / user location), re-sort the
		// exact-match candidates by the SAME prominence the FTS server uses (lookup.ts) — population and
		// nearness in one additive scale — so an in-view namesake wins a tie without a hard filter. Byte-
		// identical to the plain population order when no bias is passed. `score` here is -neg_rank =
		// log10(population + 1), so popTerm is the server formula read straight off it. Constants MIRROR
		// lookup.ts's DEFAULT_WEIGHTS (biasBoost 4, populationBoost 4, populationScaleLog10 6,
		// proximityScaleKm 100) — the #861 server↔demo parity contract; keep them in lockstep.
		if (query.bias && query.bias.length > 0) {
			const BIAS_BOOST = 4.0
			const POP_BOOST = 4.0
			const POP_SCALE_LOG10 = 6
			// SHARPER than lookup.ts's 100 km on purpose: this backend's `score` is log-population ALONE
			// (no bm25 document term), so the population signal is weaker relative to the bias and the
			// gentle 100 km decay let a 230 km-distant alias-exact township ("Paris Township", OH) edge
			// out a global city ("Paris", FR) from a nearby view. A ~30 km scale keeps the boost to
			// candidates the user is actually LOOKING at — an in-view namesake still wins (Dublin, OH from
			// an Ohio view), a distant one no longer does (Paris stays FR from a Michigan view).
			const PROX_SCALE_KM = 30
			const combinedProminence = (c: PlaceCandidate): number => {
				// Population base is the PENALIZED `prominence` (set above = -effectiveNegRank), not raw `score`, so
				// the cross-country primary preference carries into the bias-weighted order too — a coincidental
				// foreign alias doesn't ride population back over a primary just because a viewport hint is present.
				const popBase = c.prominence ?? c.score
				const popTerm = POP_BOOST * Math.min(1, Math.max(0, popBase) / POP_SCALE_LOG10)
				let proxTerm = 0

				if (!(c.lat === 0 && c.lon === 0)) {
					for (const b of query.bias!) {
						const d = haversineKm(b.lat, b.lon, c.lat, c.lon)
						const term = (BIAS_BOOST * (b.weight ?? 1)) / (1 + d / PROX_SCALE_KM)

						if (term > proxTerm) {
							proxTerm = term
						}
					}
				}

				return popTerm + proxTerm
			}
			// Persist the combined value into `prominence` so the resolver walk's `prominence ?? score` sort (and any
			// other node consumer) honors the bias order — then sort. Stable within equal prominence (preserves the
			// population order the B-tree already gave).
			candidates
				.map((c, i) => {
					c.prominence = combinedProminence(c)

					return { c, i, p: c.prominence }
				})
				.sort((a, b) => b.p - a.p || a.i - b.i)
				.forEach((x, j) => (candidates[j] = x.c))
		}

		return candidates
	}

	close(): void {
		if (this.#ownsDB) {
			this.#db.close()
		}
	}
}
