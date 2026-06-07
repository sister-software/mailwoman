/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   sql.js-httpvfs-backed resolver for the demo. Range-loads the SAME-ORIGIN DB (served from the
 *   Pages deploy) so a session fetches ~5 MB instead of the whole 53 MB — the win that matters on
 *   mobile / metered links.
 *
 *   The query SQL + ranking mirror `@mailwoman/resolver-wof-wasm`'s `WofWasmPlaceLookup` (exact-name
 *   tier → population-adjusted bm25, plus a point-in-bbox region constraint), but run ASYNC over the
 *   worker's `db.exec`. We can't share that class directly: it consumes a synchronous in-memory
 *   `@sqlite.org/sqlite-wasm` handle, whereas this talks to a Comlink-proxied sql.js worker. Keep the
 *   two ranking implementations in lockstep. (sql.js-httpvfs's WASM has no rtree module, so we only
 *   use FTS5 + plain-column bbox here — which is all the resolver path needs.)
 *
 *   sql.js-httpvfs ships a webpack UMD bundle (not ESM) and a Worker + WASM. The demo-assets plugin
 *   stages all three into `static/mailwoman/sqljs/`; we load the UMD via a classic <script> (→
 *   `window.createDbWorker`) and hand the worker + wasm URLs to it. Nothing here is bundled by
 *   webpack — that's what keeps the Docusaurus build warning-free.
 */

import type { MailwomanLookupLike } from "./resources"

const POPULATION_BOOST = 4.0
const POPULATION_SCALE_LOG10 = 6.0

const normName = (s: string): string => s.toLowerCase().trim().replace(/\s+/g, " ")
/** Escape a string literal for inline SQL (we inline rather than bind — avoids param-marshaling over Comlink). */
const sqlStr = (s: string): string => `'${s.replace(/'/g, "''")}'`

/** Trim raw input into an FTS5-safe MATCH term. Mirrors resolver-wof-wasm's sanitizeFtsQuery intent. */
function sanitizeFts(text: string): string {
	const trimmed = text.trim()
	const prefix = trimmed.endsWith("*")
	const cleaned = trimmed
		.replace(/[*]/g, " ")
		.replace(/["'()^:{}\[\]~]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
	if (!cleaned) return ""
	// Phrase-quote so multi-word names match as a unit, matching the demo's locality lookups.
	return prefix ? `"${cleaned}"*` : `"${cleaned}"`
}

/** sql.js exec result → row objects. */
function rowsFromExec(res: Array<{ columns: string[]; values: unknown[][] }> | undefined): Record<string, unknown>[] {
	if (!res || res.length === 0) return []
	const { columns, values } = res[0]
	return values.map((row) => Object.fromEntries(columns.map((c, i) => [c, row[i]])))
}

interface HttpvfsWorker {
	db: { exec(sql: string): Promise<Array<{ columns: string[]; values: unknown[][] }>> }
}

/**
 * Load the sql.js-httpvfs UMD (once) and open a DB over byte-range fetches from `dbUrl`.
 * `sqljsBaseUrl` is where the plugin staged the worker + wasm (e.g. "/mailwoman/sqljs").
 */
export async function loadHttpvfsDb(dbUrl: string, sqljsBaseUrl: string): Promise<HttpvfsWorker> {
	const w = window as unknown as { createDbWorker?: (...args: unknown[]) => Promise<HttpvfsWorker> }
	if (typeof w.createDbWorker !== "function") {
		await new Promise<void>((res, rej) => {
			const s = document.createElement("script")
			s.src = `${sqljsBaseUrl}/index.js`
			s.onload = () => res()
			s.onerror = () => rej(new Error("sql.js-httpvfs UMD failed to load"))
			document.head.appendChild(s)
		})
	}
	if (typeof w.createDbWorker !== "function") throw new Error("createDbWorker missing after UMD load")
	return w.createDbWorker(
		[{ from: "inline", config: { serverMode: "full", url: dbUrl, requestChunkSize: 65536 } }],
		`${sqljsBaseUrl}/sqlite.worker.js`,
		`${sqljsBaseUrl}/sql-wasm.wasm`
	)
}

/** PlaceLookup over the httpvfs worker — same ranking as WofWasmPlaceLookup, async. */
export class WofHttpvfsPlaceLookup implements MailwomanLookupLike {
	#worker: HttpvfsWorker
	#hasPop: boolean | undefined

	constructor(worker: HttpvfsWorker) {
		this.#worker = worker
	}

	async #hasPopulation(): Promise<boolean> {
		if (this.#hasPop === undefined) {
			const r = rowsFromExec(
				await this.#worker.db.exec("SELECT 1 FROM sqlite_master WHERE type='table' AND name='place_population' LIMIT 1")
			)
			this.#hasPop = r.length > 0
		}
		return this.#hasPop
	}

	async findPlace(query: Parameters<MailwomanLookupLike["findPlace"]>[0]) {
		const text = (query.text ?? "").trim()
		if (!text) return []
		const fts = sanitizeFts(text)
		if (!fts) return []
		const limit = Math.max(1, query.limit ?? 10)

		const conds = [`place_search MATCH ${sqlStr(fts)}`, "spr.is_current != 0", "spr.is_deprecated = 0"]
		if (query.placetype) {
			const types = (Array.isArray(query.placetype) ? query.placetype : [query.placetype]).filter(Boolean) as string[]
			if (types.length) conds.push(`spr.placetype IN (${types.map(sqlStr).join(",")})`)
		}
		if (query.country) conds.push(`spr.country = ${sqlStr(query.country.toUpperCase())}`)
		if (query.bbox) {
			const b = query.bbox
			conds.push(
				`spr.latitude BETWEEN ${Number(b.minLat)} AND ${Number(b.maxLat)} AND spr.longitude BETWEEN ${Number(b.minLon)} AND ${Number(b.maxLon)}`
			)
		}

		const hasPop = await this.#hasPopulation()
		const pool = Math.max(limit, 50)
		const sql =
			`SELECT spr.id, spr.name, spr.placetype, spr.country, spr.latitude, spr.longitude, spr.parent_id, ` +
			`spr.min_latitude, spr.max_latitude, spr.min_longitude, spr.max_longitude, ` +
			`${hasPop ? "pp.population" : "NULL"} AS population, bm25(place_search) AS bm25 ` +
			`FROM place_search JOIN spr ON spr.id = place_search.wof_id ` +
			`${hasPop ? "LEFT JOIN place_population pp ON pp.id = spr.id " : ""}` +
			`WHERE ${conds.join(" AND ")} ORDER BY bm25(place_search) ASC LIMIT ${pool}`

		const rows = rowsFromExec(await this.#worker.db.exec(sql))
		const normQuery = normName(text)
		return rows
			.map((row) => {
				const pop = typeof row.population === "number" ? row.population : 0
				const popBoost = pop > 0 ? POPULATION_BOOST * Math.min(1, Math.log10(1 + pop) / POPULATION_SCALE_LOG10) : 0
				const adj = (row.bm25 as number) - popBoost
				return { row, exactTier: normName(String(row.name)) === normQuery ? 0 : 1, adj }
			})
			.sort((a, b) => a.exactTier - b.exactTier || a.adj - b.adj)
			.slice(0, limit)
			.map(({ row, adj }) => ({
				id: row.id as number,
				name: row.name as string,
				placetype: row.placetype as string,
				lat: row.latitude as number,
				lon: row.longitude as number,
				score: -adj,
				bbox:
					row.min_latitude != null && row.max_latitude != null && row.min_longitude != null && row.max_longitude != null
						? {
								minLat: row.min_latitude as number,
								maxLat: row.max_latitude as number,
								minLon: row.min_longitude as number,
								maxLon: row.max_longitude as number,
							}
						: undefined,
			}))
	}
}

/** Polygon lookup over an httpvfs worker: id → GeoJSON geometry (async). */
export function makeHttpvfsPolygonLookup(worker: HttpvfsWorker) {
	return {
		async get(id: number): Promise<unknown | null> {
			const rows = rowsFromExec(await worker.db.exec(`SELECT geom FROM polygons WHERE id = ${Number(id)}`))
			if (rows.length === 0) return null
			try {
				return JSON.parse(String(rows[0].geom))
			} catch {
				return null
			}
		},
	}
}
