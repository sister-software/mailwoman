/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   A SECOND sql.js-httpvfs worker, byte-ranged over the published `poi.db` (`poiLayerURL()`) —
 *   category-only k-ring search for a live POI explorer. Independent of
 *   `resolver.ts`'s admin-gazetteer worker: a POI search opens its OWN worker over a
 *   different DB, over the same staged sql.js-httpvfs UMD/worker/wasm assets.
 *
 *   The k-ring walk + h3 packing REPLICATE `resolver-wof-sqlite/poi-lookup.ts`'s Node reader exactly
 *   — `latLngToCell` → `shortCellToInt` (the SHARED `@mailwoman/spatial` 48-bit packer, never
 *   reimplemented), then the same per-cell probe SQL, ring-by-ring dedup, and a final haversine sort.
 *   Keep the two readers in lockstep; a probe-semantics cross-check against the Node reader lives in
 *   the PR description, not in this tree (throwaway verification script, not shipped).
 *
 *   CATEGORY-ONLY, matching the runbook: no FTS name search, no brand search — the multi-hop demo
 *   path is deliberately excluded from this tester.
 */

import { haversineKm, shortCellToInt, type H3Cell } from "@mailwoman/spatial"
import { gridDisk, latLngToCell } from "h3-js"

import { loadHTTPVFSDatabase } from "#httpvfs/resolver"
import { rowsFromExec } from "#httpvfs/rows"

export { resolveAnchorCenter, type AnchorCenter } from "#httpvfs/poi-anchor"

/**
 * Resolution the published `poi.db`'s `h3_cell` column is keyed at — MUST match the builder (poi-lookup.ts's
 * `POI_H3_RESOLUTION`).
 */
const POI_H3_RESOLUTION = 9

/**
 * The worker handle `loadHTTPVFSDatabase` resolves to — named here since `resolver.ts` doesn't export its
 * `HTTPVFSWorker` interface.
 */
export type POIHTTPVFSWorker = Awaited<ReturnType<typeof loadHTTPVFSDatabase>>

/**
 * Open a worker over the published POI layer. Independent of the admin-gazetteer worker — a fresh `createDbWorker`
 * call, same staged UMD.
 */
export async function loadPOIWorker(poiDatabaseURL: string, sqljsBaseURL: string): Promise<POIHTTPVFSWorker> {
	return loadHTTPVFSDatabase(poiDatabaseURL, sqljsBaseURL)
}

const categoryCodesCache = new WeakMap<POIHTTPVFSWorker, Promise<Map<string, number>>>()

/**
 * `category → poi_category_codes.id`, loaded once per worker and cached (mirrors the Node reader's constructor-time
 * load).
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

export interface POISearchOpts {
	categoryID: string
	/**
	 * Fan-out leaves — the Overture `taxonomy.primary` ids this canonical category rolls up into (`supermarket` →
	 * `grocery_store`, …), from `@mailwoman/poi-taxonomy`'s `resolveOvertureCategories`. When set, every resolvable leaf
	 * is probed per cell and the rows are unioned; unknown leaves are skipped. Absent ⇒ probe `categoryID` alone
	 * (identity) — matching the Node reader's back-compat.
	 */
	categoryIDs?: string[]
	center: { lat: number; lon: number }
	/**
	 * Ring budget (default 6, k reaches 5 — empirically ~1 km against the sealed layer: a live cross-check against a real
	 * Springfield-IL cafe cluster found its NEAREST hit only at k=3, so a smaller default returned zero results for a
	 * perfectly ordinary query). Still well under the Node reader's 12-ring/~4 km default — the tester issues one
	 * explicit-click search, not a per-keystroke probe, so the request count stays bounded either way.
	 */
	maxRings?: number
	limit?: number
}

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
 * Category-only k-ring search. Probes `opts.center`'s res-9 cell, expanding ring-by-ring (deduping cells already
 * probed) until `limit` rows are on hand after a completed ring or `maxRings` is exhausted, then haversine-sorts the
 * pool. Returns `[]` for a category the DB's dictionary doesn't carry — a clean miss, not a throw.
 */
export async function searchPOICategory(worker: POIHTTPVFSWorker, opts: POISearchOpts): Promise<POISearchHit[]> {
	const limit = Math.max(1, opts.limit ?? DEFAULT_LIMIT)
	const maxRings = Math.max(1, opts.maxRings ?? DEFAULT_MAX_RINGS)
	const codes = await loadPOICategoryCodes(worker)
	// Fan the canonical seed id out over its Overture leaves (`supermarket` → grocery_store, …), resolving each through
	// the db's dictionary and dropping the ones it doesn't carry. Absent list ⇒ the seed id itself (identity).
	const seedIDs = opts.categoryIDs?.length ? opts.categoryIDs : [opts.categoryID]
	const categoryIDs = seedIDs.map((id) => codes.get(id)).filter((id): id is number => id !== undefined)

	if (!categoryIDs.length) return []
	const categoryIDList = categoryIDs.join(", ")

	const origin = latLngToCell(opts.center.lat, opts.center.lon, POI_H3_RESOLUTION) as H3Cell
	const seenCells = new Set<string>()
	const rows: Array<{ name: string; latitude: number; longitude: number; country: string; confidence: number }> = []

	// `ring` starts at 0 (the origin cell itself) — mirrors poi-lookup.ts's `#searchKRing` loop exactly.
	for (let ring = 0; ring < maxRings; ring++) {
		const diskCells = gridDisk(origin, ring) as string[]
		const newCells = diskCells.filter((cell) => !seenCells.has(cell))

		for (const cell of newCells) {
			seenCells.add(cell)
			// The SAME packing as poi-lookup.ts: the shared @mailwoman/spatial `shortCellToInt` 48-bit
			// packer — `poi.h3_cell` is the SHORTENED cell.
			const shortCell = shortCellToInt(cell as H3Cell)

			// Country is appended to the per-cell probe (beyond the spec's literal 4-column SQL) so the
			// tester's results list can show it — same WHERE/ORDER/LIMIT + packing, one extra column.
			// `category_id IN (…)` unions the fan-out leaves in one probe per cell (the ids are dictionary ints, never
			// user input — no injection surface). LIMIT still caps the per-cell pull; the outer ring loop + final sort
			// trim to the nearest `limit`.
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
