/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `WOFWasmPlaceLookup` — browser-side `PlaceLookup` backed by `@sqlite.org/sqlite-wasm`.
 *
 *   V1 scope: text + placetype + limit + country. The full ranking surface from
 *   `WOFSQLitePlaceLookup` (parentID descendant filter, near-proximity boost, bbox hard filter,
 *   population-weighted ordering) is queued for v2 in the same PR series — see Phase B tracking
 *   issue #98. The v1 scope is the minimum that lets the public demo answer "type a US city /
 *   postcode, get a hit".
 *
 *   Internally this is a thin facade over the OO1 DB returned by `loadSlimWOFDatabase`. The SQL we
 *   issue is the same SQLite dialect the Node implementation uses — once we extract the SQL
 *   building into a shared helper (planned: `@mailwoman/resolver-wof-sqlite/query-builder`), both
 *   implementations will call into the same builder and the parity guarantee becomes mechanical
 *   rather than convention-driven.
 */

import { expandPlacetypeFilter, type CoincidentLocality } from "@mailwoman/core/resolver"
import type { FindPlaceQuery, PlaceCandidate, PlaceLookup, WOFPlacetype } from "@mailwoman/resolver-wof-sqlite"
// Browser-safe subpath imports (fts.ts's only node:sqlite import is type-only) — the shared
// alias-bag parser, query fold, FTS sanitizer, and ranking weights keep this backend
// byte-identical to the Node resolver's exact tier and population re-rank.
import { aliasBagExactMatch, foldQueryText } from "@mailwoman/resolver-wof-sqlite/fts"
import { normalizePlacetypes, sanitizeFTSQuery } from "@mailwoman/resolver-wof-sqlite/fts/query"
import { DEFAULT_WEIGHTS, populationBoostTerm } from "@mailwoman/resolver-wof-sqlite/ranking-weights"
import type { Database } from "@sqlite.org/sqlite-wasm"

import { disposeSlimWOFDatabase } from "#loader"

export interface WOFWasmPlaceLookupOpts {
	/**
	 * Open `@sqlite.org/sqlite-wasm` Database (from `loadSlimWOFDatabase`).
	 */
	db: Database
}

/**
 * One `sqlite_master` probe behind the lazy aux-table checks below.
 */
function tableExists(db: Database, name: string): boolean {
	return db.selectObjects(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=? LIMIT 1`, [name]).length > 0
}

export class WOFWasmPlaceLookup implements PlaceLookup {
	readonly #db: Database
	#hasPopulationCache?: boolean
	#hasPlaceAbbrCache?: boolean
	/**
	 * Lazily-built `admin_id → coincident localities` map from the #403 relation (the slim DB carries it).
	 */
	#coincidentRolesCache?: Map<number, CoincidentLocality[]>

	constructor(opts: WOFWasmPlaceLookupOpts) {
		this.#db = opts.db
	}

	/**
	 * Lazily probe (once) whether the slim DB carries the `place_population` aux table.
	 */
	#hasPopulation(): boolean {
		if (this.#hasPopulationCache === undefined) {
			this.#hasPopulationCache = tableExists(this.#db, "place_population")
		}

		return this.#hasPopulationCache
	}

	/**
	 * Lazily probe (once) whether the slim DB carries the `place_abbr` aux table (build-slim ≥ #189).
	 */
	#hasPlaceAbbr(): boolean {
		if (this.#hasPlaceAbbrCache === undefined) {
			this.#hasPlaceAbbrCache = tableExists(this.#db, "place_abbr")
		}

		return this.#hasPlaceAbbrCache
	}

	/**
	 * Ids whose region abbreviation exactly equals `text` (case-insensitive), from `place_abbr`. The exact-abbrev tier
	 * signal — see the `findPlace` call site. Empty on slim DBs without the table.
	 */
	#abbrExactIDs(text: string): Set<number> {
		const t = text.trim()

		if (!t || !this.#hasPlaceAbbr()) return new Set()

		const rows = this.#db.selectObjects(`SELECT id FROM place_abbr WHERE abbr = ? COLLATE NOCASE`, [t]) as Array<{
			id: number
		}>

		return new Set(rows.map((r) => Number(r.id)))
	}

	async findPlace(query: FindPlaceQuery): Promise<PlaceCandidate[]> {
		const text = (query.text ?? "").trim()

		if (!text) return []

		// Postcode-typed queries keep the #920 fused name-law shape; everything else splits on
		// intra-token punctuation so hyphenated names reach the FTS as their real terms (#945) —
		// parity with the resolver-wof-sqlite implementation.
		const ftsQuery = sanitizeFTSQuery(text, {
			fuseTokens: normalizePlacetypes(query.placetype)?.includes("postalcode") ?? false,
		})

		if (!ftsQuery) return []

		const limit = Math.max(1, query.limit ?? 10)

		// FTS5 MATCH on place_search joined to spr. Placetype + country filters are pushed into the
		// WHERE clause because they reduce candidate count cheaply.
		const conditions: string[] = ["place_search MATCH ?", "spr.is_current != 0", "spr.is_deprecated = 0"]
		const params: Array<string | number> = [ftsQuery]

		// Shared placetype-equivalence expansion (core/resolver): a `locality` query must also reach
		// `borough` / `localadmin` rows. Without it, Brooklyn-the-borough (pop 2.5M, an EXACT name
		// match) was unreachable and the fuzzy "Brooklyn Park, MN" won. Same table the Node resolver
		// uses — the two backends can't drift.
		const placetypes = expandPlacetypeFilter(normalizePlacetypes(query.placetype)) as WOFPlacetype[] | null

		if (placetypes && placetypes.length) {
			conditions.push(`spr.placetype IN (${placetypes.map(() => "?").join(",")})`)
			params.push(...placetypes)
		}

		if (query.country) {
			conditions.push("spr.country = ?")
			params.push(query.country.toUpperCase())
		}

		// Point-in-bbox filter. Used to constrain a locality lookup to a parsed region/state's bounds
		// (e.g. "Roseville, Michigan" → only the Roseville whose centroid sits in Michigan's bbox),
		// which the broken-in-the-slim-DB parent_id chain can't do via descendant filtering.
		if (query.bbox) {
			conditions.push("spr.latitude BETWEEN ? AND ?", "spr.longitude BETWEEN ? AND ?")
			params.push(query.bbox.minLat, query.bbox.maxLat, query.bbox.minLon, query.bbox.maxLon)
		}

		// Over-fetch a pool ordered by raw BM25, then re-rank in JS (exact-name tier, then
		// population-weighted bm25). The over-fetch is essential: a famous place can sit a few rows
		// below a tiny same-name town on raw BM25 ("New York" loses to "West New York" by a hair), so a
		// tight LIMIT on bm25 alone would truncate it before the re-rank could pull it up. This mirrors
		// the post-scoring tier + population boost in resolver-wof-sqlite/lookup.ts. (v1 issued pure
		// bm25, which is why the demo targeted West New York for "New York, NY".)
		const hasPop = this.#hasPopulation()
		const pool = Math.max(limit, 50)

		const sql =
			`SELECT spr.id, spr.name, spr.placetype, spr.country, spr.latitude, spr.longitude, spr.parent_id, ` +
			`spr.min_latitude, spr.max_latitude, spr.min_longitude, spr.max_longitude, ` +
			`place_search.alt_names AS alt_names, ` +
			`${hasPop ? "pp.population" : "NULL"} AS population, bm25(place_search) AS bm25 ` +
			`FROM place_search JOIN spr ON spr.id = place_search.wof_id ` +
			`${hasPop ? "LEFT JOIN place_population pp ON pp.id = spr.id " : ""}` +
			`WHERE ${conditions.join(" AND ")} ` +
			`ORDER BY bm25(place_search) ASC ` +
			`LIMIT ?`

		params.push(pool)

		const rows = this.#db.selectObjects(sql, params) as Array<{
			id: number
			name: string
			placetype: string
			country: string
			latitude: number
			longitude: number
			parent_id: number | null
			min_latitude: number | null
			max_latitude: number | null
			min_longitude: number | null
			max_longitude: number | null
			alt_names: string | null
			population: number | null
			bm25: number
		}>

		const normQuery = foldQueryText(text)
		// Exact-abbreviation ids: region/state abbreviations live in the slim DB's `place_abbr` table
		// (carried by build-slim before `names` is dropped). A candidate whose abbreviation equals the
		// query is an EXACT match — same tier as an exact name match — so "VT" → Vermont outranks a
		// foreign region that merely token-matches "VT" via a multilingual name fragment. No-op on slim
		// DBs built before place_abbr (the table is absent → empty set). This is the data-driven
		// replacement for the demo's hardcoded region-abbreviation map (since deleted); it also generalizes beyond US.
		const abbrIDs = this.#abbrExactIDs(text)

		// Strict exact = canonical name or region abbreviation equals the query. Computed for the whole
		// pool FIRST because the ALIAS tier below only engages when no strict exact exists.
		const strictExact = (row: { name: string; id: number }): boolean =>
			foldQueryText(row.name) === normQuery || abbrIDs.has(row.id)

		const anyStrictExact = rows.some(strictExact)

		return rows
			.map((row) => {
				// Alias tier: `alt_names` is the FTS row's alias bag (the slim DB's only surviving alias
				// source), aliases joined on the boundary-preserving ALIAS_SEPARATOR (#523). The shared
				// parser does a true per-alias equality check, unrestricted; on a LEGACY bag (pre-#523 slim
				// artifact, boundaries lost) it falls back to padded containment conditioned on "no strictly
				// exact candidate" so interior fragments ("York" inside "New York City") can't be
				// false-promoted. Mirrors the Node resolver's alias tier
				// (`WOFSQLitePlaceLookup.#exactMatchIDs`).
				const aliasExact = aliasBagExactMatch(row.alt_names, normQuery, anyStrictExact)
				const exactTier = strictExact(row) || aliasExact ? 0 : 1

				const popBoost = populationBoostTerm(row.population, DEFAULT_WEIGHTS)

				// Lower adjScore = better, matching SQLite's bm25 convention (more negative = better).
				const adjScore = row.bm25 - popBoost

				return { row, exactTier, adjScore }
			})
			.toSorted((a, b) => a.exactTier - b.exactTier || a.adjScore - b.adjScore)
			.slice(0, limit)
			.map(({ row, adjScore, exactTier }) => ({
				id: row.id,
				name: row.name,
				placetype: row.placetype as WOFPlacetype,
				country: row.country,
				lat: row.latitude,
				lon: row.longitude,
				parent_id: row.parent_id ?? undefined,
				// Surface the exact-match tier so a downstream country re-rank (#369) can keep the country
				// pin from crossing it — parity with `WOFSQLitePlaceLookup`. See ResolvedPlace.exactMatch.
				exactMatch: exactTier === 0,
				bbox:
					row.min_latitude != null && row.max_latitude != null && row.min_longitude != null && row.max_longitude != null
						? {
								minLat: row.min_latitude,
								maxLat: row.max_latitude,
								minLon: row.min_longitude,
								maxLon: row.max_longitude,
							}
						: undefined,
				// Flip sign so higher = better (PlaceLookup contract). The adjusted, population-aware
				// score is what we sorted by, so callers see the same ordering they're shown.
				score: -adjScore,
			}))
	}

	/**
	 * Dual-role localities coincident with an admin id, from the `coincident_roles` relation (#403) carried into the slim
	 * DB by build-slim. Backs the resolver's hierarchy completion (on by default) in the browser — mirrors
	 * `WOFSQLitePlaceLookup.coincidentLocalitiesFor`. Returns `[]` when the slim DB predates the relation. Loaded once +
	 * memoized (the relation is ~hundreds of rows).
	 */
	coincidentLocalitiesFor(adminID: number | string): CoincidentLocality[] {
		const id = typeof adminID === "number" ? adminID : Number(adminID)

		if (!Number.isFinite(id)) return []

		if (!this.#coincidentRolesCache) {
			const map = new Map<number, CoincidentLocality[]>()

			if (tableExists(this.#db, "coincident_roles")) {
				const rows = this.#db.selectObjects(
					`SELECT cr.admin_id AS adminID, s.id AS id, s.name AS name, s.country AS country,
						s.latitude AS lat, s.longitude AS lon, cr.relationship_type AS relationshipType,
						cr.locality_population AS population, cr.distance_km AS distanceKm
					FROM coincident_roles cr JOIN spr s ON s.id = cr.locality_id`
				) as Array<{
					adminID: number
					id: number
					name: string
					country: string
					lat: number
					lon: number
					relationshipType: string
					population: number
					distanceKm: number
				}>

				for (const r of rows) {
					const candidate: CoincidentLocality = {
						id: r.id,
						name: r.name,
						placetype: "locality",
						country: r.country,
						lat: r.lat,
						lon: r.lon,
						score: 0,
						relationshipType: r.relationshipType,
						population: r.population,
						distanceKm: r.distanceKm,
					}

					const list = map.get(r.adminID)

					if (list) {
						list.push(candidate)
					} else {
						map.set(r.adminID, [candidate])
					}
				}
			}

			this.#coincidentRolesCache = map
		}

		return this.#coincidentRolesCache.get(id) ?? []
	}

	[Symbol.dispose](): void {
		disposeSlimWOFDatabase(this.#db)
	}
}
