/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { POIDistanceHit } from "@mailwoman/core/resolver"
import { haversineKm, shortCellToInt, type H3Cell } from "@mailwoman/spatial"
import { gridDisk, latLngToCell } from "h3-js"

import { memoizeResettable, type RangeDatabase } from "#httpvfs/database"

const POI_H3_RESOLUTION = 9

const categoryCodesCache = new WeakMap<RangeDatabase, () => Promise<Map<string, number>>>()

/**
 * Loads the POI database's category-to-code dictionary, cached once per database.
 */
export function loadPOICategoryCodes(database: RangeDatabase): Promise<Map<string, number>> {
	let cached = categoryCodesCache.get(database)

	if (!cached) {
		cached = memoizeResettable(async () => {
			const rows = await database.query<{ id: number; category: string }>("SELECT id, category FROM poi_category_codes")

			return new Map(rows.map((row) => [row.category, row.id]))
		})

		categoryCodesCache.set(database, cached)
	}

	return cached()
}

/**
 * Options for {@link searchPOICategory}; a non-empty `categoryIDs` replaces `categoryID`.
 */
export interface POISearchOpts {
	categoryID: string

	/**
	 * The Overture `taxonomy.primary` leaf ids that the canonical category rolls up,
	 * such as those from `resolveOvertureCategories`.
	 *
	 * Probes every known leaf per cell and unions the rows.
	 * Skips unknown leaves.
	 */
	categoryIDs?: string[]
	center: { lat: number; lon: number }

	/**
	 * The number of H3 rings to search outward from the center, defaulting to 6.
	 *
	 * A smaller default missed ordinary nearby clusters.
	 * The Node reader searches further by default.
	 */
	maxRings?: number
	limit?: number
}

/**
 * One POI result returned by {@link searchPOICategory}, with its distance from the search center in meters.
 */
export type POISearchHit = POIDistanceHit

interface POIRow {
	name: string | null
	latitude: number
	longitude: number
	country: string | null
	confidence: number
}

const DEFAULT_MAX_RINGS = 6
const DEFAULT_LIMIT = 10

const placeholders = (count: number): string => Array.from({ length: count }, () => "?").join(", ")

/**
 * Builds the statement that reads one ring: the top `limit` rows by rank in each of `cellCount` cells.
 *
 * The primary key leads with `(h3_cell, category_id, neg_rank)`, so each cell
 * and category pair is one B-tree seek and the whole ring is one statement.
 */
const ringSQL = (cellCount: number, categoryCount: number): string =>
	`SELECT name, latitude, longitude, confidence, country FROM (` +
	`SELECT name, latitude, longitude, confidence, country, ` +
	`row_number() OVER (PARTITION BY h3_cell ORDER BY neg_rank ASC) AS cell_rank ` +
	`FROM poi WHERE h3_cell IN (${placeholders(cellCount)}) AND category_id IN (${placeholders(categoryCount)})` +
	`) WHERE cell_rank <= ?`

/**
 * Finds the POIs of a category nearest to `opts.center` by reading H3 cells ring by ring
 * until `limit` hits are found or `maxRings` is reached.
 *
 * Each ring is one query.
 * A category absent from the database returns `[]` rather than throwing.
 */
export async function searchPOICategory(database: RangeDatabase, opts: POISearchOpts): Promise<POISearchHit[]> {
	const limit = Math.max(1, opts.limit ?? DEFAULT_LIMIT)
	const maxRings = Math.max(1, opts.maxRings ?? DEFAULT_MAX_RINGS)
	const codes = await loadPOICategoryCodes(database)

	const seedIDs = opts.categoryIDs?.length ? opts.categoryIDs : [opts.categoryID]
	const categoryIDs = seedIDs.map((id) => codes.get(id)).filter((id): id is number => id !== undefined)

	if (!categoryIDs.length) return []

	const origin = latLngToCell(opts.center.lat, opts.center.lon, POI_H3_RESOLUTION) as H3Cell
	const seenCells = new Set<string>()
	const rows: POIRow[] = []

	for (let ring = 0; ring < maxRings; ring++) {
		const ringCells = (gridDisk(origin, ring) as H3Cell[]).filter((cell) => !seenCells.has(cell))

		for (const cell of ringCells) {
			seenCells.add(cell)
		}

		const hits = await database.query<POIRow>(ringSQL(ringCells.length, categoryIDs.length), [
			...ringCells.map(shortCellToInt),
			...categoryIDs,
			limit,
		])

		for (const hit of hits) {
			if (hit.name) {
				rows.push(hit)
			}
		}

		if (rows.length >= limit) break
	}

	return rows
		.map((row) => ({
			name: row.name!,
			lat: row.latitude,
			lon: row.longitude,
			country: row.country ?? "",
			confidence: row.confidence,
			distanceM: haversineKm(opts.center.lat, opts.center.lon, row.latitude, row.longitude) * 1000,
		}))
		.toSorted((a, b) => a.distanceM - b.distanceM)
		.slice(0, limit)
}
