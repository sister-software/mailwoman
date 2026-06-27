/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Node-side {@link PlaceLookup} over the byte-range CANDIDATE table (`build-candidate.ts`) — the
 *   SAME gazetteer the browser demo resolves against ({@link WofCandidateTableLookup} in
 *   `docs/src/shared/httpvfs-resolver.ts`), but reading a LOCAL `candidate.db` via `node:sqlite`
 *   instead of sql.js-httpvfs. This is what makes the server/CLI resolver match the demo: one
 *   lookup surface, one artifact, one ranking.
 *
 *   The query is a single contiguous probe on the `WITHOUT ROWID` B-tree keyed `(name_key,
 *   country_id, region_id, placetype_id, neg_rank, spr_id)`. `name_key` is the SHARED
 *   {@link normalizeLocalityForKey} (build- and query-consistent), each row is denormalized (display
 *   `name`, centroid, bbox), and population rank is precomputed into `neg_rank` — so the result is
 *   POPULATION-FIRST and COUNTRY-AGNOSTIC (when no `country` filter is given), exactly like the
 *   demo. That's the deliberate divergence from {@link WofSqlitePlaceLookup}'s FTS/bm25 ranking: a
 *   bare "Moscow" resolves to the 10.4 M-pop Russian city, not whichever same-name US township bm25
 *   floats to the top.
 *
 *   Disambiguation rides the same mechanism the cascade already uses: a parsed region resolves to its
 *   stored bbox and the locality query is point-in-bbox-filtered on the candidate centroid (the
 *   `bbox` field on {@link FindPlaceQuery}).
 */

import { expandPlacetypeFilter } from "@mailwoman/resolver"
import { DatabaseSync } from "node:sqlite"
import { CANDIDATE_FTS_TABLE } from "./candidate-fts.js"
import type { CandidateTable, CountryCodeTable, PlacetypeCodeTable } from "./candidate-schema.js"
import { trigramJaccard } from "./lookup.js"
import { POSTAL_CITY_CANDIDATE_TABLE, type PostalCityCandidateTable } from "./postal-city-candidate-schema.js"
import { hasTable } from "./sqlite-utils.js"
import { normalizeLocalityForKey, stripLocalityQualifier } from "./street-normalize.js"
import type { FindPlaceQuery, PlaceCandidate, PlaceLookup, WofPlacetype } from "./types.js"

export interface WofCandidateTableLookupOpts {
	/** Path to a `candidate.db` built by `build-candidate.ts`. Opened read-only. */
	databasePath?: string
	/** Pre-opened handle (tests / shared connections). Mutually exclusive with `databasePath`. */
	database?: DatabaseSync
}

/**
 * The candidate columns this lookup probes — a typed projection of the SHARED
 * {@link CandidateTable}, so a column rename in `build-candidate` (the writer) is a compile error
 * here (the reader).
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
>

/**
 * FTS5-trigram over-fetch before the trigram-Jaccard re-rank, and the minimum similarity to count
 * as a fuzzy hit (below it the trigram overlap is noise, e.g. unrelated same-trigram names).
 * Tunable.
 */
const FUZZY_FETCH = 40
const FUZZY_MIN = 0.34

/**
 * Unpadded character-trigrams of `s`, OR'd into an FTS5 trigram MATCH query (each quoted so FTS
 * treats it as a literal term). Returns "" when `s` is shorter than a trigram or yields no clean
 * grams — the caller then skips the fuzzy probe.
 */
function ftsTrigramQuery(s: string): string {
	const grams = new Set<string>()
	for (let i = 0; i + 3 <= s.length; i++) {
		const g = s.slice(i, i + 3)
		if (/^[\p{L}\p{N} ]{3}$/u.test(g)) grams.add(g)
	}
	return [...grams].map((g) => `"${g}"`).join(" OR ")
}

/**
 * Node {@link PlaceLookup} over `candidate.db`. Drop-in for {@link WofSqlitePlaceLookup} in
 * `createWofResolver(backend)` — same `findPlace` contract, population-first ranking.
 */
export class WofCandidateTableLookup implements PlaceLookup {
	#db: DatabaseSync
	#ownsDb: boolean
	readonly #countryToId = new Map<string, number>()
	readonly #idToCountry = new Map<number, string>()
	readonly #placetypeToId = new Map<string, number>()
	readonly #idToPlacetype = new Map<number, string>()
	/**
	 * Prepared `(name_key, postcode)` probe for the #741 postal-city side-index — `undefined` when
	 * the `postal_city_candidate` table isn't present, so a candidate.db built without it is
	 * byte-stable.
	 */
	readonly #postalCityProbe: ReturnType<DatabaseSync["prepare"]> | undefined
	/**
	 * Prepared FTS5-trigram MATCH probe for the typo-tolerant fallback — `undefined` when the
	 * `candidate_fts` index isn't present, so a candidate.db built without it is byte-stable (the
	 * fuzzy path is skipped, exactly like today).
	 */
	readonly #ftsProbe: ReturnType<DatabaseSync["prepare"]> | undefined
	/**
	 * Prepared UNFILTERED existence probe (`name_key` present anywhere, ignoring
	 * country/placetype/bbox). Gates the fuzzy fallback: fuzzy is a TYPO corrector, so it engages
	 * only when the name doesn't exist in the gazetteer at all. A name that DOES exist but missed
	 * under the active filter is a filter miss (e.g. a placer misroute "Vienna, Austria"→IT), not a
	 * spelling miss — fuzzing it would scrape an unrelated same-country place and defeat the
	 * cascade's country-agnostic retry. Prepared only alongside `#ftsProbe`.
	 */
	readonly #nameKeyExistsProbe: ReturnType<DatabaseSync["prepare"]> | undefined

	constructor(opts: WofCandidateTableLookupOpts) {
		if (opts.database) {
			this.#db = opts.database
			this.#ownsDb = false
		} else if (opts.databasePath) {
			this.#db = new DatabaseSync(opts.databasePath, { readOnly: true })
			this.#ownsDb = true
		} else {
			throw new Error("WofCandidateTableLookup needs `databasePath` or `database`")
		}

		// The code tables are tiny (country/placetype dictionaries) — load them once at construction so
		// `findPlace` is a single B-tree probe with no dictionary round-trip.
		for (const r of this.#db.prepare("SELECT id, code FROM country_codes").all() as unknown as CountryCodeTable[]) {
			const code = String(r.code).toUpperCase()
			this.#countryToId.set(code, Number(r.id))
			this.#idToCountry.set(Number(r.id), code)
		}
		for (const r of this.#db
			.prepare("SELECT id, placetype FROM placetype_codes")
			.all() as unknown as PlacetypeCodeTable[]) {
			this.#placetypeToId.set(String(r.placetype), Number(r.id))
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
		const text = (query.text ?? "").trim()
		if (!text) return []
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
						placetype: "locality" as WofPlacetype,
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
			const cid = this.#countryToId.get(query.country.toUpperCase())
			if (cid === undefined) return [] // a country the candidate table doesn't carry
			filters.push("country_id = ?")
			filterParams.push(cid)
		}
		if (query.placetype) {
			// Shared placetype-equivalence expansion (a `locality` query must also reach borough /
			// localadmin). `postalcode` maps to no admin placetype here → empty → no rows.
			const want = Array.isArray(query.placetype) ? query.placetype : [query.placetype]
			const ids = expandPlacetypeFilter(want as readonly string[])
				.map((t) => this.#placetypeToId.get(t))
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

		const probe = (nk: string): CandidateRow[] => {
			const conds = ["name_key = ?", ...filters]
			const sql =
				"SELECT spr_id, name, country_id, placetype_id, latitude, longitude, min_lat, min_lon, max_lat, max_lon, neg_rank " +
				`FROM candidate WHERE ${conds.join(" AND ")} ORDER BY neg_rank ASC LIMIT ?`
			return this.#db.prepare(sql).all(nk, ...filterParams, limit) as unknown as CandidateRow[]
		}

		let rows = probe(nameKey)
		if (rows.length === 0) {
			// Query-side qualifier-strip fallback: an OA locality with a qualifier the gazetteer's
			// canonical name omits ("Lenk im Simmental" → "Lenk", "Roche VD"). Tried ONLY on an exact
			// miss; the cascade's region bbox disambiguates any base-name ambiguity.
			const strippedKey = normalizeLocalityForKey(stripLocalityQualifier(text))
			if (strippedKey && strippedKey !== nameKey) rows = probe(strippedKey)
		}

		// Typo-tolerant fallback (the unified gazetteer's fuzzy mode): an exact + strip miss may be a
		// misspelling the normalized key can't reach. FTS5-trigram fetches a loose set; we re-rank by
		// trigram-Jaccard (the admin backend's measure) and probe the best name_keys, so a typo resolves
		// the same on either backend. The country/placetype/bbox filters still apply via `probe`. Skipped
		// when the index is absent (byte-stable for an older candidate.db).
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
					rows.push(...probe(h.nk))
					if (rows.length >= limit) break
				}
				rows = rows.slice(0, limit)
			}
		}

		return rows.map((row): PlaceCandidate => {
			const hasBbox = row.min_lat != null && row.max_lat != null && row.min_lon != null && row.max_lon != null
			return {
				id: Number(row.spr_id),
				name: String(row.name ?? ""),
				placetype: (this.#idToPlacetype.get(Number(row.placetype_id)) ?? "") as WofPlacetype,
				// Surfaced so the cascade can country-gate a postcode by the resolved locality (an ambiguous
				// international postcode like 10115 = Berlin DE AND New York US must not out-resolve the city).
				country: this.#idToCountry.get(Number(row.country_id)) ?? "",
				lat: Number(row.latitude),
				lon: Number(row.longitude),
				score: -Number(row.neg_rank),
				// Every candidate row IS an exact normalized-name (or alias/abbrev) match — the cascade's
				// exact tier accepts alias-exact hits ("New York City" → New York) the same as canonical.
				exactMatch: true,
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
	}

	close(): void {
		if (this.#ownsDb) this.#db.close()
	}
}
