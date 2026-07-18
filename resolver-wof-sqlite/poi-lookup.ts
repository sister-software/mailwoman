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
 *   - **Brand**: the same k-ring walk, but probing on `brand_wikidata` instead — category
 *     unconstrained, so a chain's rows surface regardless of how they were categorized.
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

/** Ring budget default: 12 res-9 k-rings ≈ ~4 km. */
const DEFAULT_MAX_RINGS = 12

/** Row-count default when a query doesn't specify `limit`. */
const DEFAULT_LIMIT = 20

export interface POISearchQuery {
	/** Poi-taxonomy category id (string side of the dictionary). */
	categoryID?: string
	/** Wikidata QID for brand-exact search. */
	brandWikidata?: string
	/** Free-text name (FTS5). */
	name?: string
	/** Search center. Required for category/brand queries (k-ring expansion). */
	center?: { latitude: number; longitude: number }
	/** Ring budget: how many res-9 k-rings to expand before giving up (default 12 ≈ ~4 km). */
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
	"name" | "category_id" | "brand_wikidata" | "latitude" | "longitude" | "country" | "confidence" | "name_key"
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
	/** `(h3_cell, brand_wikidata)` → the cell's brand-matched rows (category unconstrained). */
	readonly #brandCellProbe: ReturnType<DatabaseSync["prepare"]>
	/** `name_key` → hydrate the full row(s) an FTS hit resolved to. */
	readonly #nameKeyProbe: ReturnType<DatabaseSync["prepare"]>
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

		const columns = "name, category_id, brand_wikidata, latitude, longitude, country, confidence, name_key"

		this.#categoryCellProbe = this.#db.prepare(
			`SELECT ${columns} FROM poi WHERE h3_cell = ? AND category_id = ? ORDER BY neg_rank ASC LIMIT ?`
		)
		this.#brandCellProbe = this.#db.prepare(
			`SELECT ${columns} FROM poi WHERE h3_cell = ? AND brand_wikidata = ? ORDER BY neg_rank ASC LIMIT ?`
		)
		this.#nameKeyProbe = this.#db.prepare(`SELECT ${columns} FROM poi WHERE name_key = ?`)
		this.#nameFTSProbe = this.#db.prepare(
			"SELECT name_key FROM poi_search WHERE poi_search MATCH ? ORDER BY bm25(poi_search) LIMIT ?"
		)
	}

	search(query: POISearchQuery): POISearchHit[] {
		const limit = Math.max(1, query.limit ?? DEFAULT_LIMIT)

		if (query.name) {
			return this.#searchByName(query.name, limit, query.center)
		}

		if (query.categoryID || query.brandWikidata) {
			if (!query.center) {
				throw new Error("POILookup.search: category/brand search requires a `center`")
			}

			return this.#searchKRing(query, limit)
		}

		return []
	}

	/** Category or brand path: k-ring expansion from `query.center`'s res-9 cell, probing each new ring's cells. */
	#searchKRing(query: POISearchQuery, limit: number): POISearchHit[] {
		const center = query.center!
		const maxRings = query.maxRings ?? DEFAULT_MAX_RINGS
		let categoryId: number | undefined

		if (!query.brandWikidata) {
			categoryId = this.#categoryToID.get(query.categoryID!)

			// An unknown category (not in the dictionary) can't have rows — a clean miss, not a throw.
			if (categoryId === undefined) return []
		}

		const origin = latLngToCell(center.latitude, center.longitude, POI_H3_RESOLUTION) as H3Cell
		const seenCells = new Set<string>()
		let rows: POIRow[] = []

		for (let ring = 0; ring < maxRings; ring++) {
			// gridDisk(origin, ring) returns the WHOLE disk out to `ring`; diffing against what's
			// already been probed derives just this ring's new cells.
			const diskCells = gridDisk(origin, ring) as string[]
			const newCells = diskCells.filter((cell) => !seenCells.has(cell))

			for (const cell of newCells) {
				seenCells.add(cell)
				const shortCell = h3CellToInt(cell as H3Cell)

				const hits = query.brandWikidata
					? (this.#brandCellProbe.all(shortCell, query.brandWikidata, limit) as unknown as POIRow[])
					: (this.#categoryCellProbe.all(shortCell, categoryId!, limit) as unknown as POIRow[])

				rows.push(...hits)
			}

			rows = sortByDistance(rows, center)

			if (rows.length >= limit) break
		}

		return rows.slice(0, limit).map((row) => toHit(row, this.#idToCategory, center))
	}

	/** Name path: FTS5 MATCH → hydrate by name_key. No center required; distance-sorts if one is given anyway. */
	#searchByName(name: string, limit: number, center?: { latitude: number; longitude: number }): POISearchHit[] {
		const matchQuery = sanitizePOINameQuery(name)

		if (!matchQuery) return []

		const ftsHits = this.#nameFTSProbe.all(matchQuery, limit) as unknown as Array<{ name_key: string | null }>
		const seenKeys = new Set<string>()
		let rows: POIRow[] = []

		for (const hit of ftsHits) {
			if (!hit.name_key || seenKeys.has(hit.name_key)) continue
			seenKeys.add(hit.name_key)
			rows.push(...(this.#nameKeyProbe.all(hit.name_key) as unknown as POIRow[]))
		}

		if (center) {
			rows = sortByDistance(rows, center)
		}

		return rows.slice(0, limit).map((row) => toHit(row, this.#idToCategory, center))
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
