/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Node reader for `poi.db` (spec §3.4), the res-9 k-ring reader over the clustered `poi`
 *   `without rowid` B-tree `poi-schema.ts` builds. Category, brand and name searches share one
 *   artifact. Each path has a method that returns its details.
 *
 *   `latLngToCell` and `gridDisk` come from `h3-js`. The 48-bit short-cell packing that turns a raw
 *   H3 cell into the integer `poi.h3_cell` stores is `@mailwoman/spatial`'s `shortCellToInt`, and
 *   that math is never reimplemented here.
 */

import { allRows } from "@mailwoman/core/utils"
import { haversineKm, shortCellToInt, type H3Cell } from "@mailwoman/spatial"
import type { DatabaseClient } from "@mailwoman/sqlite/client"
import { SQLiteLookup, type SQLiteLookupOptions } from "@mailwoman/sqlite/lookup"
import { gridDisk, latLngToCell } from "h3-js"

import type { POICategoryCodeTable, POIDatabase, POITable } from "#poi/schema"
/**
 * Resolution the `poi` table's `h3_cell` column is keyed at, matching the builder (spec §3.4).
 */
export const POI_H3_RESOLUTION = 9

/**
 * Ring budget default: 16 res-9 k-rings, about 5.4 km at the corner and 4.3 km worst-case.
 *
 * Category path only, since the brand path ignores rings entirely.
 * Dense categories never reach this ceiling, because the loop breaks once a ring accumulates `limit` rows.
 *
 * Sparse-but-present categories that never reach `limit` scan the fuller budget.
 * The extra rings keep the radius stable across small DB rebuilds.
 * The browser reader passes its own smaller `maxRings`.
 */
const DEFAULT_MAX_RINGS = 16

/**
 * Brand sanity radius (km).
 *
 * The brand-wide fetch returns the global nearest at any distance, so this drops
 * hits far enough away to be certainly on another continent.
 * "Applebee's near Marseille" comes back empty instead of with a 5,700 km hit.
 *
 * This is a product bound, since the index already makes the fetch cheap regardless of distance.
 */
const BRAND_MAX_DISTANCE_KM = 500

/**
 * Row-count default when a query doesn't specify `limit`.
 */
const DEFAULT_LIMIT = 20

export interface POISearchQuery {
	/**
	 * Poi-taxonomy category id (string side of the dictionary).
	 *
	 * Ignored when `brandWikidata` is also set, since brand wins.
	 */
	categoryID?: string
	/**
	 * Fan-out category ids that a single canonical Overture `taxonomy.primary` category
	 * rolls up into, as in `supermarket` → `grocery_store`, `organic_grocery_store`, ….
	 *
	 * When set, the k-ring walk probes every resolvable leaf per cell and unions the rows.
	 * Unknown leaves are skipped.
	 *
	 * Supersedes `categoryID` (which is treated as a one-element list `[categoryID]` when this is absent).
	 *
	 * Ignored when `brandWikidata` is set, since brand wins.
	 */
	categoryIDs?: string[]
	/**
	 * Wikidata QID for brand-exact search.
	 */
	brandWikidata?: string
	/**
	 * Free-text name (FTS5).
	 */
	name?: string
	/**
	 * Search center.
	 *
	 * Required for category/brand queries (k-ring expansion).
	 */
	center?: { latitude: number; longitude: number }
	/**
	 * Ring budget: how many res-9 k-rings to expand before giving up (default 16 ≈ ~5.4 km).
	 *
	 * Counts ring 0, so k reaches `maxRings - 1`.
	 */
	maxRings?: number
	limit?: number
}

export interface POISearchHit {
	name: string | null
	categoryID: string | null
	brandWikidata: string | null
	latitude: number
	longitude: number
	country: string
	confidence: number
	/**
	 * Overture gers id.
	 *
	 * Nullable metadata, never a key.
	 * See `POITable.gers_id`.
	 */
	gersID: string | null
	distanceM?: number
}

/**
 * Where a {@link POILookup} reads from.
 *
 * The source is a `poi.db` built by the POI builder, opened read-only,
 * or a connection the caller already holds.
 */
export type POILookupOpts<DB extends POIDatabase = POIDatabase> = SQLiteLookupOptions<DB>

/**
 * The `poi` columns every search mode hydrates, a typed projection of the shared {@link POITable}.
 */
type POIRow = Pick<
	POITable,
	| "name"
	| "category_id"
	| "brand_wikidata"
	| "latitude"
	| "longitude"
	| "country"
	| "confidence"
	| "name_key"
	| "gers_id"
>

/**
 * Node reader over `poi.db`.
 */
export class POILookup<DB extends POIDatabase = POIDatabase> extends SQLiteLookup<DB> {
	readonly #categoryToID = new Map<string, number>()
	readonly #idToCategory = new Map<number, string>()

	/**
	 * `(h3_cell, category_id)` → the cell's category-clustered range, most-confident-first.
	 */
	readonly #categoryCellProbe: ReturnType<DatabaseClient["prepare"]>
	/**
	 * `brand_wikidata` → all of a brand's rows globally (partial-index range-scan).
	 * The sort happens in JS.
	 */
	readonly #brandProbe: ReturnType<DatabaseClient["prepare"]>
	/**
	 * FTS5 `match` over `poi_search`, returning candidate `name_key`s to hydrate.
	 */
	readonly #nameFTSProbe: ReturnType<DatabaseClient["prepare"]>

	constructor(opts: POILookupOpts<DB>) {
		super(opts)

		// The category dictionary is tiny (poi-taxonomy's category count), so load it once
		// at construction and keep `search` from round-tripping to it.
		for (const r of allRows<POICategoryCodeTable>(
			this.database.prepare("SELECT id, category FROM poi_category_codes")
		)) {
			this.#categoryToID.set(String(r.category), Number(r.id))
			this.#idToCategory.set(Number(r.id), String(r.category))
		}

		const columns = "name, category_id, brand_wikidata, latitude, longitude, country, confidence, name_key, gers_id"

		this.#categoryCellProbe = this.database.prepare(
			`SELECT ${columns} FROM poi WHERE h3_cell = ? AND category_id = ? ORDER BY neg_rank ASC LIMIT ?`
		)

		this.#brandProbe = this.database.prepare(`SELECT ${columns} FROM poi WHERE brand_wikidata = ?`)

		this.#nameFTSProbe = this.database.prepare(
			"SELECT name_key FROM poi_search WHERE poi_search MATCH ? ORDER BY bm25(poi_search) LIMIT ?"
		)
	}

	search(query: POISearchQuery): POISearchHit[] {
		const limit = Math.max(1, query.limit ?? DEFAULT_LIMIT)

		if (query.name) {
			return this.#searchByName(query.name, limit, query.center)
		}

		if (query.categoryID || (query.categoryIDs && query.categoryIDs.length) || query.brandWikidata) {
			if (!query.center) {
				throw new Error("POILookup.search: category/brand search requires a `center`")
			}

			if (query.brandWikidata) {
				return this.#searchBrand(query.brandWikidata, query.center, limit)
			}

			return this.#searchKRing(query, limit)
		}

		return []
	}

	/**
	 * Brand path: a single brand-wide indexed fetch and no k-ring.
	 *
	 * The partial `poi_brand_wikidata` index turns the QID fetch into a range-scan
	 * instead of a 13.68M full scan.
	 * Rows are sorted by haversine distance from `center`.
	 *
	 * The lookup drops rows past {@link BRAND_MAX_DISTANCE_KM}.
	 * It returns the nearest `limit` rows.
	 */
	#searchBrand(brandWikidata: string, center: { latitude: number; longitude: number }, limit: number): POISearchHit[] {
		const rows = allRows<POIRow>(this.#brandProbe, brandWikidata)

		return sortByDistance(rows, center)
			.filter(
				(row) => haversineKm(center.latitude, center.longitude, row.latitude, row.longitude) <= BRAND_MAX_DISTANCE_KM
			)
			.slice(0, limit)
			.map((row) => toHit(row, this.#idToCategory, center))
	}

	/**
	 * Category path: k-ring expansion from `query.center`'s res-9 cell, probing each new ring's cells.
	 */
	#searchKRing(query: POISearchQuery, limit: number): POISearchHit[] {
		const center = query.center!
		const maxRings = query.maxRings ?? DEFAULT_MAX_RINGS
		const categoryIDs: number[] = []

		// `categoryIDs` (the fan-out list) supersedes the single `categoryID`.
		// Each id resolves through the dictionary.
		// Unresolved ids are dropped to cover Overture taxonomy drift and identity ids with no rows.
		const seedIDs = query.categoryIDs?.length ? query.categoryIDs : query.categoryID ? [query.categoryID] : []

		for (const id of seedIDs) {
			const resolved = this.#categoryToID.get(id)

			if (resolved !== undefined) {
				categoryIDs.push(resolved)
			}
		}

		// No resolvable leaf can have rows, since every id is unknown to the dictionary.
		// This is a clean miss instead of a throw.
		if (!categoryIDs.length) return []

		const origin = latLngToCell(center.latitude, center.longitude, POI_H3_RESOLUTION) as H3Cell
		const seenCells = new Set<string>()
		let rows: POIRow[] = []

		// `ring` starts at 0 (the origin cell itself), so this loop's k reaches `maxRings - 1`.
		for (let ring = 0; ring < maxRings; ring++) {
			// gridDisk(origin, ring) returns the whole disk out to `ring`, so diffing against
			// the already-probed set derives just this ring's new cells.
			const diskCells = gridDisk(origin, ring) as string[]
			const newCells = diskCells.filter((cell) => !seenCells.has(cell))

			for (const cell of newCells) {
				seenCells.add(cell)
				const shortCell = shortCellToInt(cell as H3Cell)

				for (const categoryID of categoryIDs) {
					rows.push(...allRows<POIRow>(this.#categoryCellProbe, shortCell, categoryID, limit))
				}
			}

			rows = sortByDistance(rows, center)

			if (rows.length >= limit) break
		}

		return rows.slice(0, limit).map((row) => toHit(row, this.#idToCategory, center))
	}

	/**
	 * Name path: FTS5 match → hydrate by name_key.
	 *
	 * No center is required.
	 * Hits are distance-sorted when one is given.
	 *
	 * Hydration is one batched `where name_key IN (...)` query over the unique `name_key`s
	 * of the FTS hits, since a per-hit probe would be up to `limit` full table scans.
	 */
	#searchByName(name: string, limit: number, center?: { latitude: number; longitude: number }): POISearchHit[] {
		const matchQuery = sanitizePOINameQuery(name)

		if (!matchQuery) return []

		const ftsHits = allRows<{ name_key: string | null }>(this.#nameFTSProbe, matchQuery, limit)
		const uniqueKeys: string[] = []
		const seenKeys = new Set<string>()

		for (const hit of ftsHits) {
			if (!hit.name_key || seenKeys.has(hit.name_key)) continue
			seenKeys.add(hit.name_key)
			uniqueKeys.push(hit.name_key)
		}

		if (!uniqueKeys.length) return []

		const hydrated = this.#hydrateByNameKeys(uniqueKeys)
		const rowsByKey = new Map<string, POIRow[]>()

		for (const row of hydrated) {
			if (row.name_key === null) continue
			const bucket = rowsByKey.get(row.name_key)

			if (bucket) {
				bucket.push(row)
			} else {
				rowsByKey.set(row.name_key, [row])
			}
		}

		let rows: POIRow[] = []

		for (const key of uniqueKeys) {
			rows.push(...(rowsByKey.get(key) ?? []))
		}

		if (center) {
			rows = sortByDistance(rows, center)
		}

		return rows.slice(0, limit).map((row) => toHit(row, this.#idToCategory, center))
	}

	/**
	 * Batched hydration for the FTS name path: `where name_key IN (?, ?, …)`,
	 * one query for the whole batch instead of one probe per FTS hit.
	 *
	 * This is a cold path (name search only) with variable arity per call,
	 * so the statement is prepared fresh each time rather than cached.
	 */
	#hydrateByNameKeys(nameKeys: string[]): POIRow[] {
		const columns = "name, category_id, brand_wikidata, latitude, longitude, country, confidence, name_key, gers_id"
		const placeholders = nameKeys.map(() => "?").join(", ")
		const stmt = this.database.prepare(`SELECT ${columns} FROM poi WHERE name_key IN (${placeholders})`)

		return allRows<POIRow>(stmt, ...nameKeys)
	}
}

function sortByDistance(rows: POIRow[], center: { latitude: number; longitude: number }): POIRow[] {
	return [...rows].toSorted(
		(a, b) =>
			haversineKm(center.latitude, center.longitude, a.latitude, a.longitude) -
			haversineKm(center.latitude, center.longitude, b.latitude, b.longitude)
	)
}

function toHit(
	row: POIRow,
	idToCategory: ReadonlyMap<number, string>,
	center?: { latitude: number; longitude: number }
): POISearchHit {
	return {
		name: row.name,
		categoryID: row.category_id !== 0 ? (idToCategory.get(row.category_id) ?? null) : null,
		brandWikidata: row.brand_wikidata,
		latitude: row.latitude,
		longitude: row.longitude,
		country: row.country,
		confidence: row.confidence,
		gersID: row.gers_id,
		...(center
			? { distanceM: haversineKm(center.latitude, center.longitude, row.latitude, row.longitude) * 1000 }
			: {}),
	}
}

/**
 * Sanitize free text into an FTS5-safe `match` query: strip the characters FTS5 would otherwise
 * read as syntax (`"` phrase delimiters, `*` prefix wildcards, `:` column-filter separators),
 * then phrase-quote each whitespace-separated token (and-joined).
 *
 * `lookup.ts` already has this discipline in `sanitizeFTSQuery`, but that function is
 * module-private there and is not re-exported from `fts.ts` or the package's `index.ts`.
 * This replicates the discipline locally rather than reach across the module boundary for a private helper.
 */
function sanitizePOINameQuery(text: string): string {
	return text
		.replaceAll(/["*:]/g, "")
		.trim()
		.split(/\s+/u)
		.filter((token) => token.length)
		.map((token) => `"${token.replaceAll('"', '""')}"`)
		.join(" ")
}
