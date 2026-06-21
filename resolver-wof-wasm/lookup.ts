/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `WofWasmPlaceLookup` — browser-side `PlaceLookup` backed by `@sqlite.org/sqlite-wasm`.
 *
 *   V1 scope: text + placetype + limit + country. The full ranking surface from
 *   `WofSqlitePlaceLookup` (parentId descendant filter, near-proximity boost, bbox hard filter,
 *   population-weighted ordering) is queued for v2 in the same PR series — see Phase B tracking
 *   issue #98. The v1 scope is the minimum that lets the public demo answer "type a US city /
 *   postcode, get a hit".
 *
 *   Internally this is a thin facade over the OO1 DB returned by `loadSlimWofDatabase`. The SQL we
 *   issue is the same SQLite dialect the Node implementation uses — once we extract the SQL
 *   building into a shared helper (planned: `@mailwoman/resolver-wof-sqlite/query-builder`), both
 *   implementations will call into the same builder and the parity guarantee becomes mechanical
 *   rather than convention-driven.
 */

import type { Database } from "@sqlite.org/sqlite-wasm"

import { expandPlacetypeFilter, type CoincidentLocality } from "@mailwoman/core/resolver"
import type { FindPlaceQuery, PlaceCandidate, PlaceLookup, WofPlacetype } from "@mailwoman/resolver-wof-sqlite"
// Browser-safe subpath import (fts.ts's only node:sqlite import is type-only) — the shared
// alias-bag parser keeps this backend's exact tier byte-identical to the Node resolver's.
import { aliasBagExactMatch } from "@mailwoman/resolver-wof-sqlite/fts"

export interface WofWasmPlaceLookupOpts {
	/** Open `@sqlite.org/sqlite-wasm` Database (from `loadSlimWofDatabase`). */
	db: Database
}

/**
 * Population-boost tunables, mirroring `resolver-wof-sqlite/lookup.ts` defaults. The boost is
 * `POPULATION_BOOST * min(1, log10(1 + pop) / POPULATION_SCALE_LOG10)`, subtracted from bm25 (lower
 * = better, matching SQLite's convention). A 1M-population city earns the full boost — enough to
 * surface the famous same-name place ("New York" over "West New York") without steamrolling a
 * clearly-better text match, because exact-name tiering is consulted FIRST.
 */
const POPULATION_BOOST = 4.0
const POPULATION_SCALE_LOG10 = 6.0

/** Normalize a name/query for exact-match tiering: lowercase, trim, collapse internal whitespace. */
function normalizeName(s: string): string {
	return s.toLowerCase().trim().replace(/\s+/g, " ")
}

export class WofWasmPlaceLookup implements PlaceLookup {
	readonly #db: Database
	#hasPopulationCache?: boolean
	#hasPlaceAbbrCache?: boolean
	/**
	 * Lazily-built `admin_id → coincident localities` map from the #403 relation (the slim DB carries
	 * it).
	 */
	#coincidentRolesCache?: Map<number, CoincidentLocality[]>

	constructor(opts: WofWasmPlaceLookupOpts) {
		this.#db = opts.db
	}

	/** Lazily probe (once) whether the slim DB carries the `place_population` aux table. */
	#hasPopulation(): boolean {
		if (this.#hasPopulationCache === undefined) {
			const r = this.#db.selectObjects(
				`SELECT 1 FROM sqlite_master WHERE type='table' AND name='place_population' LIMIT 1`
			)
			this.#hasPopulationCache = r.length > 0
		}
		return this.#hasPopulationCache
	}

	/** Lazily probe (once) whether the slim DB carries the `place_abbr` aux table (build-slim ≥ #189). */
	#hasPlaceAbbr(): boolean {
		if (this.#hasPlaceAbbrCache === undefined) {
			const r = this.#db.selectObjects(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='place_abbr' LIMIT 1`)
			this.#hasPlaceAbbrCache = r.length > 0
		}
		return this.#hasPlaceAbbrCache
	}

	/**
	 * Ids whose region abbreviation exactly equals `text` (case-insensitive), from `place_abbr`. The
	 * exact-abbrev tier signal — see the `findPlace` call site. Empty on slim DBs without the table.
	 */
	#abbrExactIds(text: string): Set<number> {
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

		const ftsQuery = sanitizeFtsQuery(text)
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
		const placetypes = expandPlacetypeFilter(normalizePlacetypes(query.placetype)) as WofPlacetype[] | null
		if (placetypes && placetypes.length > 0) {
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

		const normQuery = normalizeName(text)
		// Exact-abbreviation ids: region/state abbreviations live in the slim DB's `place_abbr` table
		// (carried by build-slim before `names` is dropped). A candidate whose abbreviation equals the
		// query is an EXACT match — same tier as an exact name match — so "VT" → Vermont outranks a
		// foreign region that merely token-matches "VT" via a multilingual name fragment. No-op on slim
		// DBs built before place_abbr (the table is absent → empty set). This is the data-driven
		// replacement for the demo's hardcoded `expandUsRegion` map; it also generalizes beyond US.
		const abbrIds = this.#abbrExactIds(text)
		// Strict exact = canonical name or region abbreviation equals the query. Computed for the whole
		// pool FIRST because the ALIAS tier below only engages when no strict exact exists.
		const strictExact = (row: { name: string; id: number }): boolean =>
			normalizeName(row.name) === normQuery || abbrIds.has(row.id)
		const anyStrictExact = rows.some(strictExact)
		return rows
			.map((row) => {
				// Alias tier: `alt_names` is the FTS row's alias bag (the slim DB's only surviving alias
				// source), aliases joined on the boundary-preserving ALIAS_SEPARATOR (#523). The shared
				// parser does a true per-alias equality check, ungated; on a LEGACY bag (pre-#523 slim
				// artifact, boundaries lost) it falls back to padded containment gated on "no strictly
				// exact candidate" so interior fragments ("York" inside "New York City") can't be
				// false-promoted. Mirrors the Node resolver's alias tier
				// (`WofSqlitePlaceLookup.#exactMatchIds`).
				const aliasExact = aliasBagExactMatch(row.alt_names, normQuery, anyStrictExact)
				const exactTier = strictExact(row) || aliasExact ? 0 : 1
				const popBoost =
					row.population && row.population > 0
						? POPULATION_BOOST * Math.min(1, Math.log10(1 + row.population) / POPULATION_SCALE_LOG10)
						: 0
				// Lower adjScore = better, matching SQLite's bm25 convention (more negative = better).
				const adjScore = row.bm25 - popBoost
				return { row, exactTier, adjScore }
			})
			.sort((a, b) => a.exactTier - b.exactTier || a.adjScore - b.adjScore)
			.slice(0, limit)
			.map(({ row, adjScore, exactTier }) => ({
				id: row.id,
				name: row.name,
				placetype: row.placetype as WofPlacetype,
				country: row.country,
				lat: row.latitude,
				lon: row.longitude,
				parent_id: row.parent_id ?? undefined,
				// Surface the exact-match tier so a downstream country re-rank (#369) can keep the country
				// pin from crossing it — parity with `WofSqlitePlaceLookup`. See ResolvedPlace.exactMatch.
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
	 * Dual-role localities coincident with an admin id, from the `coincident_roles` relation (#403)
	 * carried into the slim DB by build-slim. Backs the resolver's hierarchy completion (on by
	 * default) in the browser — mirrors `WofSqlitePlaceLookup.coincidentLocalitiesFor`. Returns `[]`
	 * when the slim DB predates the relation. Loaded once + memoized (the relation is ~hundreds of
	 * rows).
	 */
	coincidentLocalitiesFor(adminId: number | string): CoincidentLocality[] {
		const id = typeof adminId === "number" ? adminId : Number(adminId)
		if (!Number.isFinite(id)) return []
		if (!this.#coincidentRolesCache) {
			const map = new Map<number, CoincidentLocality[]>()
			const exists = this.#db.selectObjects(
				`SELECT 1 FROM sqlite_master WHERE type='table' AND name='coincident_roles' LIMIT 1`
			)
			if (exists.length > 0) {
				const rows = this.#db.selectObjects(
					`SELECT cr.admin_id AS adminId, s.id AS id, s.name AS name, s.country AS country,
						s.latitude AS lat, s.longitude AS lon, cr.relationship_type AS relationshipType,
						cr.locality_population AS population, cr.distance_km AS distanceKm
					FROM coincident_roles cr JOIN spr s ON s.id = cr.locality_id`
				) as Array<{
					adminId: number
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
					const list = map.get(r.adminId)
					if (list) list.push(candidate)
					else map.set(r.adminId, [candidate])
				}
			}
			this.#coincidentRolesCache = map
		}
		return this.#coincidentRolesCache.get(id) ?? []
	}

	close(): void {
		this.#db.close()
	}
}

/**
 * Trim raw user input into something FTS5 will accept. Preserves trailing `*` as the FTS5 prefix
 * operator (matching the resolver-wof-sqlite implementation). Strips characters FTS5 treats as
 * punctuation or operators so a user typing `Paris's` or `St. (Petersburg)` doesn't trigger an
 * "fts5: syntax error" inside the WASM runtime.
 */
function sanitizeFtsQuery(text: string): string {
	const out: string[] = []
	for (const rawToken of text.normalize("NFKC").split(/\s+/u)) {
		const trimmed = rawToken.trim()
		if (!trimmed) continue
		const hasPrefixStar = trimmed.endsWith("*")
		const body = trimmed.replace(/[^\p{L}\p{N}]/gu, "")
		if (!body) continue
		out.push(hasPrefixStar ? `${body}*` : `"${body.replace(/"/g, '""')}"`)
	}
	return out.join(" ")
}

function normalizePlacetypes(input: FindPlaceQuery["placetype"]): WofPlacetype[] | null {
	if (!input) return null
	return Array.isArray(input) ? input : [input]
}
