/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { haversineKm, shortCellToInt, type H3Cell } from "@mailwoman/spatial"
import { gridDisk, latLngToCell } from "h3-js"

import { loadHTTPVFSDatabase } from "#httpvfs/resolver"
import { rowsFromExec } from "#httpvfs/rows"

/**
 * Re-exports the gazetteer-only anchor resolver so a browser POI search can
 * place its center point from this entry point.
 */
export { resolveAnchorCenter, type AnchorCenter } from "#httpvfs/poi/anchor"

const POI_H3_RESOLUTION = 9

/**
 * The worker handle that `loadHTTPVFSDatabase` resolves to, named here
 * because `resolver.ts` does not export its type.
 */
export type POIHTTPVFSWorker = Awaited<ReturnType<typeof loadHTTPVFSDatabase>>

/**
 * Opens a new HTTP-VFS worker over the published POI database, separate from the admin-gazetteer worker.
 */
export async function loadPOIWorker(poiDatabaseURL: string, sqljsBaseURL: string): Promise<POIHTTPVFSWorker> {
	return loadHTTPVFSDatabase(poiDatabaseURL, sqljsBaseURL)
}

const categoryCodesCache = new WeakMap<POIHTTPVFSWorker, Promise<Map<string, number>>>()

/**
 * Loads the POI database's category-to-code dictionary, cached once per worker.
 */
export function loadPOICategoryCodes(worker: POIHTTPVFSWorker): Promise<Map<string, number>> {
	let cached = categoryCodesCache.get(worker)

	if (!cached) {
		cached = worker.db.exec("SELECT id, category FROM poi_category_codes").then((res) => {
			const map = new Map<string, number>()

			for (const row of rowsFromExec(res)) {
				map.set(String(row.category), Number(row.id))
			}

			return map
		})

		categoryCodesCache.set(worker, cached)
	}

	return cached
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
	 * Every known leaf is probed per cell and the rows are unioned, and unknown leaves are skipped.
	 */
	categoryIDs?: string[]
	center: { lat: number; lon: number }

	/**
	 * The number of H3 rings to search outward from the center, defaulting to 6.
	 *
	 * A smaller default missed ordinary nearby clusters, and the Node reader searches further by default.
	 */
	maxRings?: number
	limit?: number
}

/**
 * One named POI returned by {@link searchPOICategory}, with its distance from the search center in meters.
 */
export interface POISearchHit {
	name: string
	lat: number
	lon: number
	distanceM: number
	country: string
	confidence: number
}

const DEFAULT_MAX_RINGS = 6
const DEFAULT_LIMIT = 10

/**
 * Finds the POIs of a category nearest to `opts.center` by probing H3 cells ring by ring
 * until `limit` hits are found or `maxRings` is reached.
 *
 * A category the database does not carry returns `[]` rather than throwing.
 */
export async function searchPOICategory(worker: POIHTTPVFSWorker, opts: POISearchOpts): Promise<POISearchHit[]> {
	const limit = Math.max(1, opts.limit ?? DEFAULT_LIMIT)
	const maxRings = Math.max(1, opts.maxRings ?? DEFAULT_MAX_RINGS)
	const codes = await loadPOICategoryCodes(worker)

	const seedIDs = opts.categoryIDs?.length ? opts.categoryIDs : [opts.categoryID]
	const categoryIDs = seedIDs.map((id) => codes.get(id)).filter((id): id is number => id !== undefined)

	if (!categoryIDs.length) return []
	const categoryIDList = categoryIDs.join(", ")

	const origin = latLngToCell(opts.center.lat, opts.center.lon, POI_H3_RESOLUTION) as H3Cell
	const seenCells = new Set<string>()
	const rows: Array<{ name: string; latitude: number; longitude: number; country: string; confidence: number }> = []

	for (let ring = 0; ring < maxRings; ring++) {
		const diskCells = gridDisk(origin, ring) as string[]
		const newCells = diskCells.filter((cell) => !seenCells.has(cell))

		for (const cell of newCells) {
			seenCells.add(cell)

			const shortCell = shortCellToInt(cell as H3Cell)

			const sql =
				`SELECT name, latitude, longitude, confidence, country FROM poi ` +
				`WHERE h3_cell = ${shortCell} AND category_id IN (${categoryIDList}) ORDER BY neg_rank ASC LIMIT ${limit}`

			const hits = rowsFromExec<{
				name: string | null
				latitude: number
				longitude: number
				country: string | null
				confidence: number
			}>(await worker.db.exec(sql))

			for (const hit of hits) {
				if (hit.name) {
					rows.push({
						name: hit.name,
						latitude: hit.latitude,
						longitude: hit.longitude,
						country: hit.country ?? "",
						confidence: hit.confidence,
					})
				}
			}
		}

		if (rows.length >= limit) break
	}

	return rows
		.map((row) => ({
			name: row.name,
			lat: row.latitude,
			lon: row.longitude,
			country: row.country,
			confidence: row.confidence,
			distanceM: haversineKm(opts.center.lat, opts.center.lon, row.latitude, row.longitude) * 1000,
		}))
		.toSorted((a, b) => a.distanceM - b.distanceM)
		.slice(0, limit)
}
