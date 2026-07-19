/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   A SECOND sql.js-httpvfs worker, byte-ranged over the published `poi.db` (`poiLayerURL()`) —
 *   category-only k-ring search for the docs POI tester (`POIExplorer` / try-it.mdx). Independent of
 *   `httpvfs-resolver.ts`'s admin-gazetteer worker: a POI search opens its OWN worker over a
 *   different DB, over the same staged sql.js-httpvfs UMD/worker/wasm assets.
 *
 *   The k-ring walk + h3 packing REPLICATE `resolver-wof-sqlite/poi-lookup.ts`'s Node reader exactly
 *   — `latLngToCell` → `shortenH3Cell` (the SHARED `@mailwoman/spatial` 48-bit packer, never
 *   reimplemented) → `Number(BigInt("0x"+short))`, then the same per-cell probe SQL, ring-by-ring
 *   dedup, and a final haversine sort. Keep the two readers in lockstep; a probe-semantics cross-check
 *   against the Node reader lives in the PR description, not in this tree (throwaway verification
 *   script, not shipped).
 *
 *   CATEGORY-ONLY, matching the runbook: no FTS name search, no brand search — the multi-hop demo
 *   path is deliberately excluded from this tester.
 */

import { isUSStateAbbreviation } from "@mailwoman/codex/us"
import { haversineKm, shortenH3Cell, type H3Cell } from "@mailwoman/spatial"
import { gridDisk, latLngToCell } from "h3-js"

import { loadHTTPVFSDatabase, WOFCandidateTableLookup } from "./httpvfs-resolver.ts"
import { adminGazetteerURL, poiLayerURL } from "./resources.tsx"

/**
 * Resolution the published `poi.db`'s `h3_cell` column is keyed at — MUST match the builder (poi-lookup.ts's
 * `POI_H3_RESOLUTION`).
 */
const POI_H3_RESOLUTION = 9

/**
 * The worker handle `loadHTTPVFSDatabase` resolves to — named here since `httpvfs-resolver.ts` doesn't export its
 * `HTTPVFSWorker` interface.
 */
export type POIHTTPVFSWorker = Awaited<ReturnType<typeof loadHTTPVFSDatabase>>

/**
 * Open a worker over the published POI layer. Independent of the admin-gazetteer worker — a fresh `createDbWorker`
 * call, same staged UMD.
 */
export async function loadPOIWorker(sqljsBaseURL: string): Promise<POIHTTPVFSWorker> {
	return loadHTTPVFSDatabase(poiLayerURL(), sqljsBaseURL)
}

/** Sql.js exec result → row objects. Kept local — `httpvfs-resolver.ts`'s equivalent helper isn't exported. */
function rowsFromExec(res: Array<{ columns: string[]; values: unknown[][] }> | undefined): Record<string, unknown>[] {
	if (!res || res.length === 0) return []
	const { columns, values } = res[0]!

	return values.map((row) => Object.fromEntries(columns.map((c, i) => [c, row[i]])))
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
	const categoryId = codes.get(opts.categoryID)

	if (categoryId === undefined) return []

	const origin = latLngToCell(opts.center.lat, opts.center.lon, POI_H3_RESOLUTION) as H3Cell
	const seenCells = new Set<string>()
	const rows: Array<{ name: string; latitude: number; longitude: number; country: string; confidence: number }> = []

	// `ring` starts at 0 (the origin cell itself) — mirrors poi-lookup.ts's `#searchKRing` loop exactly.
	for (let ring = 0; ring < maxRings; ring++) {
		const diskCells = gridDisk(origin, ring) as string[]
		const newCells = diskCells.filter((cell) => !seenCells.has(cell))

		for (const cell of newCells) {
			seenCells.add(cell)
			// The SAME packing as poi-lookup.ts's h3CellToInt: shortenH3Cell (the shared @mailwoman/spatial
			// 48-bit packer) then a straight hex→Number(BigInt) cast — `poi.h3_cell` is the SHORTENED cell.
			const shortCell = Number(BigInt(`0x${shortenH3Cell(cell as H3Cell)}`))
			// Country is appended to the per-cell probe (beyond the spec's literal 4-column SQL) so the
			// tester's results list can show it — same WHERE/ORDER/LIMIT + packing, one extra column.
			const sql =
				`SELECT name, latitude, longitude, confidence, country FROM poi ` +
				`WHERE h3_cell = ${shortCell} AND category_id = ${categoryId} ORDER BY neg_rank ASC LIMIT ${limit}`
			const hits = rowsFromExec(await worker.db.exec(sql)) as unknown as Array<{
				name: string | null
				latitude: number
				longitude: number
				country: string | null
				confidence: number
			}>

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
		.sort((a, b) => a.distanceM - b.distanceM)
		.slice(0, limit)
}

// ---------------------------------------------------------------------------
// Anchor → center resolution (no neural runtime)
// ---------------------------------------------------------------------------

let candidateWorkerPromise: Promise<POIHTTPVFSWorker> | undefined

/**
 * Lazily open (once, shared across calls) the ADMIN CANDIDATE gazetteer worker used only for anchor→center resolution.
 * Independent of the POI-layer worker — a separate byte-ranged DB, the same one `/demo`'s cascade resolves localities
 * against ({@link WOFCandidateTableLookup}).
 */
function loadCandidateWorker(sqljsBaseURL: string): Promise<POIHTTPVFSWorker> {
	if (!candidateWorkerPromise) {
		candidateWorkerPromise = loadHTTPVFSDatabase(adminGazetteerURL(), sqljsBaseURL).catch((err: unknown) => {
			candidateWorkerPromise = undefined
			throw err
		})
	}

	return candidateWorkerPromise
}

export interface AnchorCenter {
	lat: number
	lon: number
	/** The resolved place's canonical name — surfaced so the UI can show what "Springfield" resolved to. */
	name: string
}

/**
 * Split an anchor string into a locality + an optional region qualifier, WITHOUT a neural parse. Two forms: a comma
 * ("Springfield, IL") splits there; otherwise a trailing US state abbreviation token ("Springfield IL" — the common
 * comma-less form) splits on whitespace. Anything else is treated as a bare locality name — no disambiguation region,
 * population-first candidate ranking wins (which is exactly the ambiguity a query like "Springfield" alone has: this
 * tester makes no claim to resolve it "correctly", only consistently with the `/demo` cascade's default).
 */
function splitAnchor(text: string): { localityText: string; regionText?: string } {
	const commaIndex = text.indexOf(",")

	if (commaIndex >= 0) {
		return { localityText: text.slice(0, commaIndex).trim(), regionText: text.slice(commaIndex + 1).trim() }
	}

	const lastSpace = text.lastIndexOf(" ")

	if (lastSpace > 0) {
		const trailingToken = text.slice(lastSpace + 1).trim()

		if (isUSStateAbbreviation(trailingToken)) {
			return { localityText: text.slice(0, lastSpace).trim(), regionText: trailingToken }
		}
	}

	return { localityText: text }
}

/**
 * Resolve an anchor string ("Springfield", "Springfield, IL", or "Springfield IL") to a center point against the admin
 * candidate gazetteer — no neural runtime, no full-address parse. When a region qualifier splits off (see
 * {@link splitAnchor}) it's resolved FIRST (for its bbox), then the locality lookup is point-in-bbox-constrained by it,
 * the same disambiguation the `/demo` cascade uses. Returns `null` when nothing resolves — callers show "couldn't place
 * '<anchor>'" rather than silently defaulting to zero results.
 */
export async function resolveAnchorCenter(sqljsBaseURL: string, anchorText: string): Promise<AnchorCenter | null> {
	const trimmed = anchorText.trim()

	if (!trimmed) return null

	const worker = await loadCandidateWorker(sqljsBaseURL)
	const lookup = new WOFCandidateTableLookup(worker)

	const { localityText, regionText } = splitAnchor(trimmed)

	let bbox: { minLat: number; maxLat: number; minLon: number; maxLon: number } | undefined

	if (regionText) {
		const regionHits = await lookup.findPlace({ text: regionText, placetype: "region", limit: 1 })

		bbox = regionHits[0]?.bbox
	}

	if (!localityText) return null

	const localityHits = await lookup.findPlace({
		text: localityText,
		placetype: ["locality"],
		...(bbox ? { bbox } : {}),
		limit: 1,
	})

	const hit = localityHits[0]

	if (!hit) return null

	return { lat: hit.lat, lon: hit.lon, name: hit.name }
}
