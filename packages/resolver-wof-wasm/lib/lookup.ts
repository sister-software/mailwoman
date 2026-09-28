/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * `WOFWasmPlaceLookup`, the browser-side `PlaceLookup` backed by `@sqlite.org/sqlite-wasm`.
 *
 * The lookup filters on text, placetype, limit, country alongside a bounding box, then re-ranks the
 * BM25 pool by exact-name tier and population weight using the shared helpers the Node resolver uses.
 * The slim artifact's `parent_id` chain is incomplete, so this lookup lacks `WOFSQLitePlaceLookup`'s
 * parentID descendant filter. It also lacks the near-proximity boost.
 *
 * Internally this is a thin facade over the OO1 DB returned by `loadSlimWOFDatabase`. It issues SQL in the same
 * SQLite dialect as the Node implementation. The alias-bag parser, query fold,
 * FTS sanitizer and ranking weights are imported from `@mailwoman/resolver-wof-sqlite` so the two
 * backends share one implementation of each rather than a convention.
 */

import { expandPlacetypeFilter } from "@mailwoman/codex/placetype-map"
import type { CoincidentLocality } from "@mailwoman/core/resolver"
import type { FindPlaceQuery, PlaceCandidate, PlaceLookup, WOFPlacetype } from "@mailwoman/resolver-wof-sqlite"
// Browser-safe subpath imports (fts.ts's only node:sqlite import is type-only).
// The shared alias-bag parser and query fold keep this backend byte-identical to Node's exact tier.
// The shared FTS sanitizer and ranking weights preserve its query and ranking behavior.
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
// repo-health-ignore private-name-shadows-export -- the same probe over a synchronous sqlite-wasm handle.
// The httpvfs export answers a worker round trip.
// The sqlite export answers a node:sqlite client. and no adapter unifies the three handles
function tableExists(db: Database, name: string): boolean {
	return db.selectObjects(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=? LIMIT 1`, [name]).length > 0
}

export class WOFWasmPlaceLookup implements PlaceLookup {
	readonly #db: Database
	#hasPopulationCache?: boolean
	#hasPlaceAbbrCache?: boolean
	/**
	 * Lazily-built `admin_id` to coincident-localities map from the `coincident_roles`
	 * relation in the slim DB.
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
	 * Lazily probe (once) whether the slim DB carries the `place_abbr` aux table that build-slim adds.
	 */
	#hasPlaceAbbr(): boolean {
		if (this.#hasPlaceAbbrCache === undefined) {
			this.#hasPlaceAbbrCache = tableExists(this.#db, "place_abbr")
		}

		return this.#hasPlaceAbbrCache
	}

	/**
	 * Ids whose region abbreviation exactly equals `text` (case-insensitive), from `place_abbr`.
	 *
	 * The exact-abbrev tier signal.
	 * See the `findPlace` call site.
	 * Empty on slim DBs without the table.
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

		// Postcode-typed queries keep the fused name-law shape.
		// Everything else splits on intra-token punctuation so hyphenated names reach the FTS
		// as their real terms, in parity with the resolver-wof-sqlite implementation.
		const ftsQuery = sanitizeFTSQuery(text, {
			fuseTokens: normalizePlacetypes(query.placetype)?.includes("postalcode") ?? false,
		})

		if (!ftsQuery) return []

		const limit = Math.max(1, query.limit ?? 10)

		// FTS5 match on place_search joined to spr.
		// Placetype and country filters are pushed into the where clause to reduce candidate count cheaply.
		const conditions: string[] = ["place_search MATCH ?", "spr.is_current != 0", "spr.is_deprecated = 0"]
		const params: Array<string | number> = [ftsQuery]

		// Shared placetype-equivalence expansion (core/resolver): a `locality` query
		// must also reach `borough` and `localadmin` rows, the same table the Node
		// resolver uses, so the two backends cannot drift.
		const placetypes = expandPlacetypeFilter(normalizePlacetypes(query.placetype)) as WOFPlacetype[] | null

		if (placetypes && placetypes.length) {
			conditions.push(`spr.placetype IN (${placetypes.map(() => "?").join(",")})`)
			params.push(...placetypes)
		}

		if (query.country) {
			conditions.push("spr.country = ?")
			params.push(query.country.toUpperCase())
		}

		// Point-in-bbox filter, used to constrain a locality lookup to a parsed region or state's bounds
		// (for example "Roseville, Michigan" reaches only the Roseville whose centroid sits in Michigan's bbox),
		// which the incomplete `parent_id` chain in the slim DB cannot do through descendant filtering.
		if (query.bbox) {
			conditions.push("spr.latitude BETWEEN ? AND ?", "spr.longitude BETWEEN ? AND ?")
			params.push(query.bbox.minLat, query.bbox.maxLat, query.bbox.minLon, query.bbox.maxLon)
		}

		// Over-fetch a pool ordered by raw BM25, then re-rank in JS by exact-name tier
		// and population-weighted bm25.
		// The over-fetch is essential.
		// A famous place can sit a few rows below a tiny same-name town on raw BM25,
		// so a tight limit would truncate it before the re-rank could pull it up.
		// This mirrors the post-scoring tier and population boost in resolver-wof-sqlite/lookup.ts.
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
		// Exact-abbreviation ids: region and state abbreviations live in the slim DB's
		// `place_abbr` table, carried by build-slim before `names` is dropped.
		// A candidate whose abbreviation equals the query is an exact match, the same tier
		// as an exact name match, so "VT" reaches Vermont ahead of a foreign region that
		// merely token-matches "VT" through a multilingual name fragment.
		// The lookup is a no-op on slim DBs built before `place_abbr`, where the
		// table is absent and the set is empty.
		const abbrIDs = this.#abbrExactIDs(text)

		// Strict exact means the canonical name or region abbreviation equals the query.
		// Computed for the whole pool first, since the alias tier below only engages
		// when no strict exact exists.
		const strictExact = (row: { name: string; id: number }): boolean =>
			foldQueryText(row.name) === normQuery || abbrIDs.has(row.id)

		const anyStrictExact = rows.some(strictExact)

		return rows
			.map((row) => {
				// Alias tier: `alt_names` is the FTS row's alias bag, the slim DB's only surviving
				// alias source, with aliases joined on the boundary-preserving ALIAS_SEPARATOR.
				// The shared parser does a true per-alias equality check, unrestricted.
				// On a legacy bag with boundaries lost, it falls back to padded containment
				// conditioned on "no strictly exact candidate", so interior fragments
				// ("York" inside "New York City") cannot be false-promoted.
				// Mirrors the Node resolver's alias tier (`WOFSQLitePlaceLookup.#exactMatchIDs`).
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
				// Surface the exact-match tier so a downstream country re-rank can keep the
				// country pin from crossing it, in parity with `WOFSQLitePlaceLookup`.
				// See ResolvedPlace.exactMatch.
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
				// Flip sign so higher = better (PlaceLookup interface).
				// The adjusted, population-aware score is what we sorted by, so callers
				// see the same ordering they're shown.
				score: -adjScore,
			}))
	}

	/**
	 * Dual-role localities coincident with an admin id, from the `coincident_roles`
	 * relation carried into the slim DB by build-slim.
	 *
	 * Backs the resolver's hierarchy completion in the browser and
	 * mirrors `WOFSQLitePlaceLookup.coincidentLocalitiesFor`.
	 * Returns `[]` when the slim DB predates the relation.
	 *
	 * Loaded once and memoized, since the relation is a few hundred rows.
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
