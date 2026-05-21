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

import type { FindPlaceQuery, PlaceCandidate, PlaceLookup, WofPlacetype } from "@mailwoman/resolver-wof-sqlite"

export interface WofWasmPlaceLookupOpts {
	/** Open `@sqlite.org/sqlite-wasm` Database (from `loadSlimWofDatabase`). */
	db: Database
}

export class WofWasmPlaceLookup implements PlaceLookup {
	readonly #db: Database

	constructor(opts: WofWasmPlaceLookupOpts) {
		this.#db = opts.db
	}

	async findPlace(query: FindPlaceQuery): Promise<PlaceCandidate[]> {
		const text = (query.text ?? "").trim()
		if (!text) return []

		const ftsQuery = sanitizeFtsQuery(text)
		if (!ftsQuery) return []

		const limit = Math.max(1, query.limit ?? 10)

		// v1 query: FTS5 MATCH on place_search joined to spr. BM25 ordering. Placetype + country
		// filters are pushed into the WHERE clause because they reduce candidate count cheaply.
		// Boosts (placetype-match boost, locality implicit boost, population weighting) deliberately
		// omitted — they need the same ranking weights / constants as lookup.ts and that's a shared
		// query-builder PR away.
		const conditions: string[] = ["place_search MATCH ?", "spr.is_current != 0", "spr.is_deprecated = 0"]
		const params: Array<string | number> = [ftsQuery]

		const placetypes = normalizePlacetypes(query.placetype)
		if (placetypes && placetypes.length > 0) {
			conditions.push(`spr.placetype IN (${placetypes.map(() => "?").join(",")})`)
			params.push(...placetypes)
		}
		if (query.country) {
			conditions.push("spr.country = ?")
			params.push(query.country.toUpperCase())
		}

		const sql =
			`SELECT spr.id, spr.name, spr.placetype, spr.country, spr.latitude, spr.longitude, spr.parent_id, ` +
			`spr.min_latitude, spr.max_latitude, spr.min_longitude, spr.max_longitude, bm25(place_search) AS bm25 ` +
			`FROM place_search JOIN spr ON spr.id = place_search.wof_id ` +
			`WHERE ${conditions.join(" AND ")} ` +
			`ORDER BY bm25(place_search) ASC ` +
			`LIMIT ?`
		params.push(limit)

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
			bm25: number
		}>

		return rows.map((row) => ({
			id: row.id,
			name: row.name,
			placetype: row.placetype as WofPlacetype,
			country: row.country,
			lat: row.latitude,
			lon: row.longitude,
			parent_id: row.parent_id ?? undefined,
			bbox:
				row.min_latitude != null && row.max_latitude != null && row.min_longitude != null && row.max_longitude != null
					? {
							minLat: row.min_latitude,
							maxLat: row.max_latitude,
							minLon: row.min_longitude,
							maxLon: row.max_longitude,
						}
					: undefined,
			// BM25 is negative (better = more negative). Flip sign so higher = better, matching the
			// PlaceLookup contract.
			score: -row.bm25,
		}))
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
