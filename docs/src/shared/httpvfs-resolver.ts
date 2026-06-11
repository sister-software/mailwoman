/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Sql.js-httpvfs-backed resolver for the demo. Range-loads the SAME-ORIGIN DB (served from the
 *   Pages deploy) so a session fetches ~5 MB instead of the whole 53 MB — the win that matters on
 *   mobile / metered links.
 *
 *   The query SQL + ranking mirror `@mailwoman/resolver-wof-wasm`'s `WofWasmPlaceLookup` (exact-name
 *   tier → population-adjusted bm25, plus a point-in-bbox region constraint), but run ASYNC over
 *   the worker's `db.exec`. We can't share that class directly: it consumes a synchronous in-memory
 *   `@sqlite.org/sqlite-wasm` handle, whereas this talks to a Comlink-proxied sql.js worker. Keep
 *   the two ranking implementations in lockstep. (sql.js-httpvfs's WASM has no rtree module, so we
 *   only use FTS5 + plain-column bbox here — which is all the resolver path needs.)
 *
 *   Sql.js-httpvfs ships a webpack UMD bundle (not ESM) and a Worker + WASM. The demo-assets plugin
 *   stages all three into `static/mailwoman/sqljs/`; we load the UMD via a classic <script> (→
 *   `window.createDbWorker`) and hand the worker + wasm URLs to it. Nothing here is bundled by
 *   webpack — that's what keeps the Docusaurus build warning-free.
 */

import { expandPlacetypeFilter } from "@mailwoman/core/resolver"

import type { DualRole, MailwomanLookupLike } from "./resources"

const POPULATION_BOOST = 4.0
const POPULATION_SCALE_LOG10 = 6.0

const normName = (s: string): string => s.toLowerCase().trim().replace(/\s+/g, " ")
/**
 * Escape a string literal for inline SQL (we inline rather than bind — avoids param-marshaling over
 * Comlink).
 */
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

/** Sql.js exec result → row objects. */
function rowsFromExec(res: Array<{ columns: string[]; values: unknown[][] }> | undefined): Record<string, unknown>[] {
	if (!res || res.length === 0) return []
	const { columns, values } = res[0]
	return values.map((row) => Object.fromEntries(columns.map((c, i) => [c, row[i]])))
}

interface HttpvfsWorker {
	db: { exec(sql: string): Promise<Array<{ columns: string[]; values: unknown[][] }>> }
	/**
	 * Total bytes range-fetched from the DB so far (Comlink property read on the worker). Drives the
	 * live transfer readout during warm-up; returns 0 if the worker doesn't expose the counter.
	 */
	bytesRead(): Promise<number>
}

/** The raw shape `createDbWorker` resolves to — `worker` is the Comlink proxy. */
interface RawWorkerHttpvfs {
	db: HttpvfsWorker["db"]
	worker?: { bytesRead?: number | Promise<number> }
}

export interface HttpvfsOptions {
	/**
	 * Bytes per HTTP range request. Default 65536 (64 KiB = 16 SQLite pages). Fetches inside the
	 * worker are SYNCHRONOUS XHR, so cold latency ≈ uncached-chunk-count × RTT: bigger chunks cut
	 * round-trips on FTS-walk-heavy access (the hot DB) at the cost of over-fetching on sparse
	 * single-row access (the polygon DB). Measure against the spike baseline (38 req / 3.6 MB per
	 * session, `resolver-wof-sqlite/spike/RESULTS.md`) before changing.
	 */
	requestChunkSize?: number
}

/**
 * Load the sql.js-httpvfs UMD (once) and open a DB over byte-range fetches from `dbUrl`.
 * `sqljsBaseUrl` is where the plugin staged the worker + wasm (e.g. "/mailwoman/sqljs").
 */
export async function loadHttpvfsDb(
	dbUrl: string,
	sqljsBaseUrl: string,
	options: HttpvfsOptions = {}
): Promise<HttpvfsWorker> {
	const w = window as unknown as { createDbWorker?: (...args: unknown[]) => Promise<RawWorkerHttpvfs> }
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

	// Open over byte-range fetches, then force the header + schema pages through SQLite with a
	// cheap read. On mobile Safari the HTTP cache can hand sql.js-httpvfs a torn 64 KB range chunk,
	// which surfaces as "database disk image is malformed"; the assets' immutable Cache-Control means
	// a once-poisoned cache entry is trusted indefinitely, so the only escape is a fresh URL. Try the
	// cacheable URL first (fast — Cloudflare edge-caches the ranges); if it opens corrupt, retry ONCE
	// with a cache-busting query param to force fresh chunks. Self-heals a poisoned cache without
	// permanently defeating caching for the happy path. See the 2026-06 mobile-Safari demo report.
	const open = async (url: string): Promise<HttpvfsWorker> => {
		const raw = await w.createDbWorker!(
			[
				{
					from: "inline",
					config: { serverMode: "full", url, requestChunkSize: options.requestChunkSize ?? 65536 },
				},
			],
			`${sqljsBaseUrl}/sqlite.worker.js`,
			`${sqljsBaseUrl}/sql-wasm.wasm`
		)
		await raw.db.exec("SELECT count(*) FROM sqlite_master") // throws here if the schema chunk is torn
		return {
			db: raw.db,
			bytesRead: async () => {
				try {
					return Number(await raw.worker?.bytesRead) || 0
				} catch {
					return 0
				}
			},
		}
	}
	try {
		return await open(dbUrl)
	} catch (err) {
		if (!/malformed|not a database|disk image/i.test(String(err))) throw err
		const sep = dbUrl.includes("?") ? "&" : "?"
		return open(`${dbUrl}${sep}cb=${Date.now()}`)
	}
}

/** All table-existence facts the lookup needs, resolved in ONE worker round trip. */
interface SchemaFacts {
	hasPop: boolean
	hasAbbr: boolean
	hasRoles: boolean
}

/** PlaceLookup over the httpvfs worker — same ranking as WofWasmPlaceLookup, async. */
export class WofHttpvfsPlaceLookup implements MailwomanLookupLike {
	#worker: HttpvfsWorker
	#schemaProbe: Promise<SchemaFacts> | undefined
	#dualRoles: Promise<Map<number, DualRole[]>> | undefined

	constructor(worker: HttpvfsWorker) {
		this.#worker = worker
	}

	/**
	 * Table-existence probes batched as scalar subqueries — one statement, one worker round trip —
	 * instead of one `sqlite_master` query per table. Worker fetches are synchronous XHR, so on a
	 * cold cache every extra round trip is a full network RTT. Memoized as the in-flight promise so
	 * concurrent callers share it; a rejection clears the memo so a transient failure can retry.
	 */
	#schema(): Promise<SchemaFacts> {
		if (!this.#schemaProbe) {
			this.#schemaProbe = this.#worker.db
				.exec(
					`SELECT
						(SELECT count(*) FROM sqlite_master WHERE type='table' AND name='place_population') AS has_pop,
						(SELECT count(*) FROM sqlite_master WHERE type='table' AND name='place_abbr') AS has_abbr,
						(SELECT count(*) FROM sqlite_master WHERE type='table' AND name='coincident_roles') AS has_roles`
				)
				.then((res) => {
					const row = rowsFromExec(res)[0] ?? {}
					return {
						hasPop: Number(row.has_pop) > 0,
						hasAbbr: Number(row.has_abbr) > 0,
						hasRoles: Number(row.has_roles) > 0,
					}
				})
			this.#schemaProbe.catch(() => {
				this.#schemaProbe = undefined
			})
		}
		return this.#schemaProbe
	}

	/**
	 * The full dual-role relation, loaded once (in-flight-memoized; the relation is ~hundreds of
	 * rows).
	 */
	#dualRolesMap(): Promise<Map<number, DualRole[]>> {
		if (!this.#dualRoles) {
			this.#dualRoles = (async () => {
				const map = new Map<number, DualRole[]>()
				const { hasRoles } = await this.#schema()
				if (!hasRoles) return map
				const rows = rowsFromExec(
					await this.#worker.db.exec(
						`SELECT cr.admin_id AS adminId, cr.locality_id AS localityId, cr.relationship_type AS rel,
							a.name AS adminName, a.placetype AS adminType, l.name AS locName, l.placetype AS locType
						FROM coincident_roles cr JOIN spr a ON a.id = cr.admin_id JOIN spr l ON l.id = cr.locality_id`
					)
				)
				const push = (key: number, role: DualRole): void => {
					const arr = map.get(key) ?? []
					arr.push(role)
					map.set(key, arr)
				}
				for (const r of rows) {
					const adminId = Number(r.adminId)
					const localityId = Number(r.localityId)
					const rel = String(r.rel)
					// Resolved place is the locality → it ALSO acts as the region (the admin partner).
					push(localityId, {
						id: adminId,
						name: String(r.adminName),
						placetype: String(r.adminType),
						relationshipType: rel,
						role: "region",
					})
					// Resolved place is the admin → it ALSO acts as the locality.
					push(adminId, {
						id: localityId,
						name: String(r.locName),
						placetype: String(r.locType),
						relationshipType: rel,
						role: "locality",
					})
				}
				return map
			})()
			this.#dualRoles.catch(() => {
				this.#dualRoles = undefined
			})
		}
		return this.#dualRoles
	}

	/**
	 * Dual-role lookup (#402): a city-state / capital-seat place holds two admin tiers under one name
	 * (Berlin is both a region and a locality). The `coincident_roles` relation pairs an `admin_id`
	 * with the `locality_id` it doubles as; this returns the PARTNER role for a resolved place in
	 * EITHER direction, so the demo can badge "Berlin → also a region (city-state)" whether the parse
	 * resolved the city or the state. Returns `[]` when the slim DB predates the relation
	 * (existence-guarded) — degrades silently.
	 */
	async coincidentRolesFor(placeId: number): Promise<DualRole[]> {
		if (!Number.isFinite(placeId)) return []
		return (await this.#dualRolesMap()).get(placeId) ?? []
	}

	/**
	 * Pull the hot pages through the VFS before the first real lookup: the schema probe, the
	 * dual-role relation, the abbreviation table, and a representative FTS5 join that walks the
	 * `place_search` index + `spr` b-tree roots. Everything fetched is exactly what the first
	 * `findPlace` needs, so running this during browser idle time moves the cold serial range
	 * round-trips off the user's first submit. Idempotent and safe to race with real queries (probes
	 * are in-flight-memoized; the worker serializes execs).
	 */
	async warmUp(): Promise<void> {
		const { hasPop, hasAbbr } = await this.#schema()
		const stmts = [
			`SELECT spr.id${hasPop ? ", pp.population" : ""} ` +
				`FROM place_search JOIN spr ON spr.id = place_search.wof_id ` +
				`${hasPop ? "LEFT JOIN place_population pp ON pp.id = spr.id " : ""}` +
				`WHERE place_search MATCH '"springfield"' AND spr.is_current != 0 AND spr.is_deprecated = 0 LIMIT 3`,
		]
		if (hasAbbr) stmts.push(`SELECT id FROM place_abbr WHERE abbr = 'ny' COLLATE NOCASE LIMIT 1`)
		await Promise.all([this.#worker.db.exec(stmts.join(";\n")), this.#dualRolesMap()])
	}

	/** Total bytes range-fetched so far — surfaces live transfer progress in the demo UI. */
	bytesRead(): Promise<number> {
		return this.#worker.bytesRead()
	}

	/**
	 * Ids whose region abbreviation exactly equals `text` (case-insensitive), from the slim DB's
	 * `place_abbr` table (carried by build-slim, #189). Empty on DBs built before the table. Lets the
	 * demo resolver tier an exact-abbrev match ("VT" → Vermont) above a foreign region that merely
	 * token-matches — the data-driven replacement for the hardcoded `expandUsRegion` map. Mirrors
	 * `WofWasmPlaceLookup.#abbrExactIds` (keep the two in lockstep).
	 */
	async #abbrExactIds(text: string): Promise<Set<number>> {
		const t = text.trim()
		if (!t || !(await this.#schema()).hasAbbr) return new Set()
		const rows = rowsFromExec(
			await this.#worker.db.exec(`SELECT id FROM place_abbr WHERE abbr = ${sqlStr(t)} COLLATE NOCASE`)
		)
		return new Set(rows.map((r) => Number(r.id)))
	}

	async findPlace(query: Parameters<MailwomanLookupLike["findPlace"]>[0]) {
		const text = (query.text ?? "").trim()
		if (!text) return []
		const fts = sanitizeFts(text)
		if (!fts) return []
		const limit = Math.max(1, query.limit ?? 10)

		const conds = [`place_search MATCH ${sqlStr(fts)}`, "spr.is_current != 0", "spr.is_deprecated = 0"]
		if (query.placetype) {
			// Shared placetype-equivalence expansion (core/resolver): a `locality` query must also reach
			// `borough` / `localadmin` rows — Brooklyn-the-borough is a borough, not a locality, and a
			// strict filter made it unreachable (the "Brooklyn → Brooklyn Park, MN" bug).
			const types = expandPlacetypeFilter(
				(Array.isArray(query.placetype) ? query.placetype : [query.placetype]).filter(Boolean) as string[]
			)
			if (types.length) conds.push(`spr.placetype IN (${types.map(sqlStr).join(",")})`)
		}
		if (query.country) conds.push(`spr.country = ${sqlStr(query.country.toUpperCase())}`)
		if (query.bbox) {
			const b = query.bbox
			conds.push(
				`spr.latitude BETWEEN ${Number(b.minLat)} AND ${Number(b.maxLat)} AND spr.longitude BETWEEN ${Number(b.minLon)} AND ${Number(b.maxLon)}`
			)
		}

		const { hasPop } = await this.#schema()
		const pool = Math.max(limit, 50)
		const sql =
			`SELECT spr.id, spr.name, spr.placetype, spr.country, spr.latitude, spr.longitude, spr.parent_id, ` +
			`spr.min_latitude, spr.max_latitude, spr.min_longitude, spr.max_longitude, ` +
			`place_search.alt_names AS alt_names, ` +
			`${hasPop ? "pp.population" : "NULL"} AS population, bm25(place_search) AS bm25 ` +
			`FROM place_search JOIN spr ON spr.id = place_search.wof_id ` +
			`${hasPop ? "LEFT JOIN place_population pp ON pp.id = spr.id " : ""}` +
			`WHERE ${conds.join(" AND ")} ORDER BY bm25(place_search) ASC LIMIT ${pool}`

		// Exact-abbrev tier: a candidate whose region abbreviation equals the query ("VT" → Vermont) is
		// an exact match, same tier as an exact name match — so it outranks a foreign region that merely
		// token-matches "VT". Mirrors WofWasmPlaceLookup; no-op on slim DBs without `place_abbr`.
		// Issued together with the main query — the queries are independent and the worker pipelines
		// them, saving a main-thread→worker round-trip gap per lookup.
		const [rows, abbrIds] = await Promise.all([this.#worker.db.exec(sql).then(rowsFromExec), this.#abbrExactIds(text)])
		const normQuery = normName(text)
		// Strict exact = canonical name or region abbreviation equals the query. Computed for the whole
		// pool FIRST because the ALIAS tier below only engages when no strict exact exists.
		const strictExact = (row: Record<string, unknown>): boolean =>
			normName(String(row.name)) === normQuery || abbrIds.has(Number(row.id))
		const anyStrictExact = rows.some(strictExact)
		return rows
			.map((row) => {
				const pop = typeof row.population === "number" ? row.population : 0
				const popBoost = pop > 0 ? POPULATION_BOOST * Math.min(1, Math.log10(1 + pop) / POPULATION_SCALE_LOG10) : 0
				const adj = (row.bm25 as number) - popBoost
				// Alias tier: `alt_names` is the FTS row's alias bag (all `names` rows space-joined). Name
				// boundaries are LOST in the bag, so a containment check would false-promote interior
				// fragments ("York" matches inside "New York City") — it only engages when NO candidate is
				// strictly exact: the "New York City" case, where the query is a WOF alias of the New York
				// locality but no spr row bears the name. Mirrors WofWasmPlaceLookup.
				const aliasExact =
					!anyStrictExact &&
					typeof row.alt_names === "string" &&
					` ${normName(row.alt_names)} `.includes(` ${normQuery} `)
				const exactTier = strictExact(row) || aliasExact ? 0 : 1
				return { row, exactTier, adj }
			})
			.sort((a, b) => a.exactTier - b.exactTier || a.adj - b.adj)
			.slice(0, limit)
			.map(({ row, adj, exactTier }) => ({
				id: row.id as number,
				name: row.name as string,
				placetype: row.placetype as string,
				lat: row.latitude as number,
				lon: row.longitude as number,
				score: -adj,
				// Surfaced so the demo cascade can accept an alias-exact hit ("New York City" → New York)
				// the same way it accepts a canonical-name match.
				exactMatch: exactTier === 0,
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
