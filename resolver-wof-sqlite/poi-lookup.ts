/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Node reader for `poi.db` (spec §3.4) — the res-9 k-ring reader over the clustered `poi`
 *   `WITHOUT ROWID` B-tree Task 1's schema (`poi-schema.ts`) builds. Three search modes share one
 *   artifact:
 *
 *   - **Category**: `latLngToCell(center, 9)` → `gridDisk` ring-by-ring expansion, probing each
 *     cell's clustered `(h3_cell, category_id, neg_rank, …)` range. Rings accumulate until `limit`
 *     rows are on hand after a completed ring, or `maxRings` is exhausted; the pool is sorted by
 *     haversine distance from `center` after every ring.
 *   - **Brand**: NOT a k-ring walk. Brand rows are globally sparse (~0.31% of poi.db; median nearest
 *     tagged instance ~110 km), so ring expansion could never reach them. Instead a single brand-wide
 *     indexed fetch on `brand_wikidata` (the partial `poi_brand_wikidata` index) pulls EVERY row for
 *     the QID — category unconstrained — then haversine-sorts from `center` and takes the nearest
 *     `limit`, bounded by a `BRAND_MAX_DISTANCE_KM` sanity radius.
 *   - **Name**: FTS5 `MATCH` against the `poi_search` virtual table, hydrated back to full rows by
 *     `name_key`. No center required; if one is given, hits are still distance-sorted.
 *
 *   `latLngToCell`/`gridDisk` come from `h3-js`; the 48-bit short-cell packing that turns a raw H3
 *   cell into the integer `poi.h3_cell` stores is `@mailwoman/spatial`'s `shortenH3Cell` — that math
 *   is NEVER reimplemented here (see AGENTS.md on `@mailwoman/spatial` being the one true home for
 *   it).
 */

import { DatabaseSync } from "node:sqlite"

import { haversineKm, shortenH3Cell, type H3Cell } from "@mailwoman/spatial"
import { gridDisk, latLngToCell } from "h3-js"

import type { POICategoryCodeTable, POITable } from "./poi-schema.ts"

/** Resolution the `poi` table's `h3_cell` column is keyed at — matches the builder (spec §3.4). */
export const POI_H3_RESOLUTION = 9

/**
 * Ring budget default: 16 res-9 k-rings ≈ ~5.4 km (corner) / ~4.3 km worst-bearing. Category path only — the brand path
 * ignores rings entirely.
 *
 * Raised from 12 (≈4 km) after nm-04 ("hiking trail near Marseille") exposed a boundary miss for SPARSE categories: the
 * nearest `trail` instance sits at 3.90 km, but the res-9 disk of radius 11 (maxRings 12) reaches only ~3.16 km in its
 * worst bearing — the cell holding that trail isn't covered until ring 13 (maxRings 14). Dense categories are
 * unaffected: the loop breaks the ring it accumulates `limit` rows (cafe@Paris fills 20 by ring 2), so this ceiling
 * never enters their probe budget. Only sparse-but-present categories that never reach `limit` scan the fuller budget —
 * a cold, one-shot `mailwoman poi` path, not per-keystroke. 16 (not the bare threshold 14) leaves ~2 rings of margin so
 * the gate is stable against small db rebuilds, while staying ~4x tighter than the board's 25 km "roughly right place"
 * window (no wrong-city false positives). The browser reader passes its own smaller `maxRings` and is untouched.
 */
const DEFAULT_MAX_RINGS = 16

/**
 * Brand sanity radius (km): the brand-wide fetch returns the global nearest at ANY distance, so this drops hits far
 * enough to be certainly the wrong continent — "Applebee's near Marseille" comes back empty rather than with a 5,700 km
 * hit. A product bound, not a reach cap (the index already makes the fetch cheap regardless of distance).
 */
const BRAND_MAX_DISTANCE_KM = 500

/** Row-count default when a query doesn't specify `limit`. */
const DEFAULT_LIMIT = 20

export interface POISearchQuery {
	/** Poi-taxonomy category id (string side of the dictionary). Ignored when `brandWikidata` is also set — brand wins. */
	categoryID?: string
	/**
	 * Fan-out category ids — the Overture `taxonomy.primary` leaves a single canonical category rolls up into (e.g.
	 * `supermarket` → `grocery_store`, `organic_grocery_store`, …). When set, the k-ring walk probes EVERY resolvable
	 * leaf per cell and unions the rows; unknown leaves are skipped. Supersedes `categoryID` (which is treated as a
	 * one-element list `[categoryID]` when this is absent). Ignored when `brandWikidata` is set — brand wins.
	 */
	categoryIDs?: string[]
	/** Wikidata QID for brand-exact search. */
	brandWikidata?: string
	/** Free-text name (FTS5). */
	name?: string
	/** Search center. Required for category/brand queries (k-ring expansion). */
	center?: { latitude: number; longitude: number }
	/**
	 * Ring budget: how many res-9 k-rings to expand before giving up (default 16 ≈ ~5.4 km). Counts ring 0, so k reaches
	 * `maxRings - 1`.
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
	/** Overture GERS id — nullable METADATA ONLY, never a key (the #470 rule; see `POITable.gers_id`). */
	gersID: string | null
	distanceM?: number
}

export interface POILookupOpts {
	/** Path to a `poi.db` built by the (future) POI builder. Opened read-only. */
	databasePath?: string
	/** Pre-opened handle (tests / shared connections). Mutually exclusive with `databasePath`. */
	database?: DatabaseSync
}

/** The `poi` columns every search mode hydrates — a typed projection of the SHARED {@link POITable}. */
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
 * Node reader over `poi.db`. `implements Disposable` so callers can `using lookup = new POILookup(...)` (or call
 * `[Symbol.dispose]()` explicitly), the same precedent as {@link WOFCandidateTableLookup} /
 * {@link WOFSqlitePlaceLookup}.
 */
export class POILookup implements Disposable {
	#db: DatabaseSync
	#ownsDB: boolean
	readonly #categoryToID = new Map<string, number>()
	readonly #idToCategory = new Map<number, string>()

	/** `(h3_cell, category_id)` → the cell's category-clustered range, most-confident-first. */
	readonly #categoryCellProbe: ReturnType<DatabaseSync["prepare"]>
	/** `brand_wikidata` → ALL of a brand's rows globally (partial-index range-scan); distance-sorted in JS, not SQL. */
	readonly #brandProbe: ReturnType<DatabaseSync["prepare"]>
	/** FTS5 `MATCH` over `poi_search`, returning candidate `name_key`s to hydrate. */
	readonly #nameFTSProbe: ReturnType<DatabaseSync["prepare"]>

	constructor(opts: POILookupOpts) {
		if (opts.database) {
			this.#db = opts.database
			this.#ownsDB = false
		} else if (opts.databasePath) {
			this.#db = new DatabaseSync(opts.databasePath, { readOnly: true })
			this.#ownsDB = true
		} else {
			throw new Error("POILookup needs `databasePath` or `database`")
		}

		// The category dictionary is tiny (poi-taxonomy's category count) — load it once at
		// construction so `search` never round-trips to it.
		for (const r of this.#db
			.prepare("SELECT id, category FROM poi_category_codes")
			.all() as unknown as POICategoryCodeTable[]) {
			this.#categoryToID.set(String(r.category), Number(r.id))
			this.#idToCategory.set(Number(r.id), String(r.category))
		}

		const columns = "name, category_id, brand_wikidata, latitude, longitude, country, confidence, name_key, gers_id"

		this.#categoryCellProbe = this.#db.prepare(
			`SELECT ${columns} FROM poi WHERE h3_cell = ? AND category_id = ? ORDER BY neg_rank ASC LIMIT ?`
		)
		this.#brandProbe = this.#db.prepare(`SELECT ${columns} FROM poi WHERE brand_wikidata = ?`)
		this.#nameFTSProbe = this.#db.prepare(
			"SELECT name_key FROM poi_search WHERE poi_search MATCH ? ORDER BY bm25(poi_search) LIMIT ?"
		)
	}

	search(query: POISearchQuery): POISearchHit[] {
		const limit = Math.max(1, query.limit ?? DEFAULT_LIMIT)

		if (query.name) {
			return this.#searchByName(query.name, limit, query.center)
		}

		if (query.categoryID || (query.categoryIDs && query.categoryIDs.length > 0) || query.brandWikidata) {
			if (!query.center) {
				throw new Error("POILookup.search: category/brand search requires a `center`")
			}

			// brandWikidata wins over categoryID(s) when both are set — see POISearchQuery.categoryID. The brand path is
			// a brand-wide indexed fetch, NOT a k-ring walk (brand rows are too sparse for ring expansion to reach).
			if (query.brandWikidata) {
				return this.#searchBrand(query.brandWikidata, query.center, limit)
			}

			return this.#searchKRing(query, limit)
		}

		return []
	}

	/**
	 * Brand path: a single brand-wide indexed fetch — NO k-ring. Fetch EVERY row for the QID (the partial
	 * `poi_brand_wikidata` index makes this a range-scan, not a 13.68M full scan), haversine-sort from `center`, drop
	 * anything past the {@link BRAND_MAX_DISTANCE_KM} sanity radius, and take the nearest `limit`. Returns the true
	 * nearest at any distance — the reach ceiling k-ring hits on sparse brand rows is gone.
	 */
	#searchBrand(brandWikidata: string, center: { latitude: number; longitude: number }, limit: number): POISearchHit[] {
		const rows = this.#brandProbe.all(brandWikidata) as unknown as POIRow[]

		return sortByDistance(rows, center)
			.filter(
				(row) => haversineKm(center.latitude, center.longitude, row.latitude, row.longitude) <= BRAND_MAX_DISTANCE_KM
			)
			.slice(0, limit)
			.map((row) => toHit(row, this.#idToCategory, center))
	}

	/** Category path: k-ring expansion from `query.center`'s res-9 cell, probing each new ring's cells. */
	#searchKRing(query: POISearchQuery, limit: number): POISearchHit[] {
		const center = query.center!
		const maxRings = query.maxRings ?? DEFAULT_MAX_RINGS
		const categoryIds: number[] = []

		// `categoryIDs` (the fan-out list) supersedes the single `categoryID`; either way, resolve each id through the
		// dictionary and drop the ones the db doesn't carry (Overture-taxonomy drift, or an identity id with no rows).
		const seedIDs = query.categoryIDs?.length ? query.categoryIDs : query.categoryID ? [query.categoryID] : []

		for (const id of seedIDs) {
			const resolved = this.#categoryToID.get(id)

			if (resolved !== undefined) {
				categoryIds.push(resolved)
			}
		}

		// No resolvable leaf (every id unknown to the dictionary) can't have rows — a clean miss, not a throw.
		if (categoryIds.length === 0) return []

		const origin = latLngToCell(center.latitude, center.longitude, POI_H3_RESOLUTION) as H3Cell
		const seenCells = new Set<string>()
		let rows: POIRow[] = []

		// `ring` starts at 0 (the origin cell itself), so this loop's k reaches `maxRings - 1`.
		for (let ring = 0; ring < maxRings; ring++) {
			// gridDisk(origin, ring) returns the WHOLE disk out to `ring`; diffing against what's
			// already been probed derives just this ring's new cells.
			const diskCells = gridDisk(origin, ring) as string[]
			const newCells = diskCells.filter((cell) => !seenCells.has(cell))

			for (const cell of newCells) {
				seenCells.add(cell)
				const shortCell = h3CellToInt(cell as H3Cell)

				// Fan-out: probe every resolved Overture leaf for this canonical category, unioning the rows. The
				// post-ring distance sort + `slice(0, limit)` below dedupes the pool down to the nearest `limit`.
				for (const categoryId of categoryIds) {
					rows.push(...(this.#categoryCellProbe.all(shortCell, categoryId, limit) as unknown as POIRow[]))
				}
			}

			rows = sortByDistance(rows, center)

			if (rows.length >= limit) break
		}

		return rows.slice(0, limit).map((row) => toHit(row, this.#idToCategory, center))
	}

	/**
	 * Name path: FTS5 MATCH → hydrate by name_key. No center required; distance-sorts if one is given anyway.
	 *
	 * Hydration is ONE batched `WHERE name_key IN (...)` query over the FTS hits' unique `name_key`s, not a per-hit probe
	 * — with up to `limit` FTS hits, a per-hit probe was up to `limit` full table scans before `createPOINameKeyIndex`
	 * (poi-schema.ts) + this batching.
	 */
	#searchByName(name: string, limit: number, center?: { latitude: number; longitude: number }): POISearchHit[] {
		const matchQuery = sanitizePOINameQuery(name)

		if (!matchQuery) return []

		const ftsHits = this.#nameFTSProbe.all(matchQuery, limit) as unknown as Array<{ name_key: string | null }>
		const uniqueKeys: string[] = []
		const seenKeys = new Set<string>()

		for (const hit of ftsHits) {
			if (!hit.name_key || seenKeys.has(hit.name_key)) continue
			seenKeys.add(hit.name_key)
			uniqueKeys.push(hit.name_key)
		}

		if (uniqueKeys.length === 0) return []

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
	 * Batched hydration for the FTS name path: `WHERE name_key IN (?, ?, …)`, one query for the whole batch instead of
	 * one probe per FTS hit. This is a cold path (name search only) with variable arity per call, so the statement is
	 * prepared fresh each time rather than cached.
	 */
	#hydrateByNameKeys(nameKeys: string[]): POIRow[] {
		const columns = "name, category_id, brand_wikidata, latitude, longitude, country, confidence, name_key, gers_id"
		const placeholders = nameKeys.map(() => "?").join(", ")
		const stmt = this.#db.prepare(`SELECT ${columns} FROM poi WHERE name_key IN (${placeholders})`)

		return stmt.all(...nameKeys) as unknown as POIRow[]
	}

	close(): void {
		if (this.#ownsDB) {
			this.#db.close()
		}
	}

	[Symbol.dispose](): void {
		this.close()
	}
}

/** `poi.h3_cell` is the SHORTENED (48-bit) cell — never the full h3-js cell string. */
function h3CellToInt(cell: H3Cell): number {
	return Number(BigInt(`0x${shortenH3Cell(cell)}`))
}

function sortByDistance(rows: POIRow[], center: { latitude: number; longitude: number }): POIRow[] {
	return [...rows].sort(
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
 * Sanitize free text into an FTS5-safe MATCH query: strip the characters FTS5 would otherwise read as syntax (`"`
 * phrase delimiters, `*` prefix wildcards, `:` column-filter separators), then phrase-quote each whitespace-separated
 * token (AND-joined).
 *
 * `resolver-wof-sqlite` already has this discipline — `lookup.ts`'s `sanitizeFTSQuery` — but that function is
 * module-private there (not re-exported from `fts.ts` or the package's `index.ts`), so this replicates the same
 * discipline locally rather than reaching across the module boundary for a private helper.
 */
function sanitizePOINameQuery(text: string): string {
	return text
		.replace(/["*:]/g, "")
		.trim()
		.split(/\s+/u)
		.filter(Boolean)
		.map((token) => `"${token.replace(/"/g, '""')}"`)
		.join(" ")
}
