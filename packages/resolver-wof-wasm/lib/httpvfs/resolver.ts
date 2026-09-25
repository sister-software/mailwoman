/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { expandPlacetypeFilter } from "@mailwoman/codex/placetype-map"
import { tryParsingJSON } from "@mailwoman/core/json"
import { isPresent } from "@mailwoman/core/objects"
import { referentialFromPopulation } from "@mailwoman/core/resolver"
import type { CandidateTable } from "@mailwoman/resolver-wof-sqlite/candidate-schema"
import { ALIAS_SEPARATOR, aliasBagExactMatch } from "@mailwoman/resolver-wof-sqlite/fts"
import {
	rankByPrimaryPreference,
	type RankedRow,
	RERANK_FETCH,
} from "@mailwoman/resolver-wof-sqlite/primary-preference"
import { applyProximityRerank } from "@mailwoman/resolver-wof-sqlite/proximity-rerank"
import { normalizeLocalityForKey, stripLocalityQualifier } from "@mailwoman/resolver-wof-sqlite/street/normalize"

import type { DualRole, MailwomanLookupLike } from "#browser-cascade"
import { memoizeResettable, rowsFromExec, tableExists } from "#httpvfs/rows"

type CandidateProbeRow = Pick<
	CandidateTable,
	| "spr_id"
	| "name"
	| "country_id"
	| "placetype_id"
	| "latitude"
	| "longitude"
	| "min_lat"
	| "min_lon"
	| "max_lat"
	| "max_lon"
	| "neg_rank"
> &
	Partial<Pick<CandidateTable, "population" | "is_primary" | "importance">>

const POPULATION_BOOST = 4
const POPULATION_SCALE_LOG10 = 6

const normName = (s: string): string => s.toLowerCase().trim().replaceAll(/\s+/g, " ")

const sqlStr = (s: string): string => `'${s.replaceAll("'", "''")}'`

function sanitizeFTS(text: string): string {
	const trimmed = text.trim()
	const prefix = trimmed.endsWith("*")

	const cleaned = trimmed
		.replaceAll(/[*]/g, " ")
		.replaceAll(/["'()^:{}[\]~]/g, " ")
		.replaceAll(ALIAS_SEPARATOR, " ")
		.replaceAll(/\s+/g, " ")
		.trim()

	if (!cleaned) return ""

	return prefix ? `"${cleaned}"*` : `"${cleaned}"`
}

/**
 * Wraps an sql.js-httpvfs worker as the async query handle and fetched-byte
 * counter that the browser lookups use.
 */
export interface HTTPVFSWorker {
	db: { exec(sql: string): Promise<Array<{ columns: string[]; values: unknown[][] }>> }

	/**
	 * Returns the total bytes range-fetched from the database so far, or 0
	 * when the worker exposes no counter.
	 */
	bytesRead(): Promise<number>
}

interface RawWorkerHTTPVFS {
	db: HTTPVFSWorker["db"]
	worker?: { bytesRead?: number | Promise<number> }
}

/**
 * Tunes the HTTP VFS, where `requestChunkSize` is the byte-range fetch size and defaults to 64 KiB.
 */
export interface HTTPSVFSOptions {
	/**
	 * The bytes per HTTP range request, defaulting to 65536.
	 *
	 * The worker fetches with synchronous XHR, so larger chunks save round trips on
	 * FTS-heavy reads but over-fetch on sparse single-row reads.
	 */
	requestChunkSize?: number
}

/**
 * Types the global `createDbWorker` function that the sql.js-httpvfs UMD script installs.
 */
export interface DBWorkerFactory {
	createDbWorker?: (...args: unknown[]) => Promise<RawWorkerHTTPVFS>
}

/**
 * Loads the sql.js-httpvfs UMD from `sqljsBaseURL` if it is not already present,
 * then opens the database at `dbURL` over byte-range fetches.
 *
 * If the first open reports a malformed database, it retries once with a cache-busting
 * query string, because a stale cached response can serve bytes from an older file.
 */
export async function loadHTTPVFSDatabase(
	dbURL: string,
	sqljsBaseURL: string,
	options: HTTPSVFSOptions = {}
): Promise<HTTPVFSWorker> {
	const w = globalThis as DBWorkerFactory

	if (typeof w.createDbWorker !== "function") {
		await new Promise<void>((res, rej) => {
			const s = document.createElement("script")

			s.src = `${sqljsBaseURL}/index.js`
			s.onload = () => res()
			s.onerror = () => rej(new Error("sql.js-httpvfs UMD failed to load"))

			document.head.appendChild(s)
		})
	}

	if (typeof w.createDbWorker !== "function") {
		throw new TypeError("createDbWorker missing after UMD load")
	}

	const open = async (url: string): Promise<HTTPVFSWorker> => {
		const raw = await w.createDbWorker!(
			[
				{
					from: "inline",
					config: { serverMode: "full", url, requestChunkSize: options.requestChunkSize ?? 65_536 },
				},
			],
			`${sqljsBaseURL}/sqlite.worker.js`,
			`${sqljsBaseURL}/sql-wasm.wasm`
		)

		await raw.db.exec("SELECT count(*) FROM sqlite_master")

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
		return await open(dbURL)
	} catch (error) {
		if (!/malformed|not a database|disk image/i.test(String(error))) throw error
		const sep = dbURL.includes("?") ? "&" : "?"

		return open(`${dbURL}${sep}cb=${Date.now()}`)
	}
}

interface SchemaFacts {
	hasPop: boolean
	hasAbbr: boolean
	hasRoles: boolean
}

/**
 * PlaceLookup over the httpvfs worker — same ranking as WOFWasmPlaceLookup, async.
 */
export class WOFHTTPVFSPlaceLookup implements MailwomanLookupLike {
	#worker: HTTPVFSWorker

	constructor(worker: HTTPVFSWorker) {
		this.#worker = worker
	}

	readonly #schema = memoizeResettable(() =>
		this.#worker.db
			.exec(
				`SELECT
					(SELECT count(*) FROM sqlite_master WHERE type='table' AND name='place_population') AS has_pop,
					(SELECT count(*) FROM sqlite_master WHERE type='table' AND name='place_abbr') AS has_abbr,
					(SELECT count(*) FROM sqlite_master WHERE type='table' AND name='coincident_roles') AS has_roles`
			)
			.then((res): SchemaFacts => {
				const row = rowsFromExec(res)[0] ?? {}

				return {
					hasPop: Number(row.has_pop) > 0,
					hasAbbr: Number(row.has_abbr) > 0,
					hasRoles: Number(row.has_roles) > 0,
				}
			})
	)

	readonly #dualRolesMap = memoizeResettable(async (): Promise<Map<number, DualRole[]>> => {
		const map = new Map<number, DualRole[]>()
		const { hasRoles } = await this.#schema()

		if (!hasRoles) return map

		const rows = rowsFromExec(
			await this.#worker.db.exec(
				`SELECT cr.admin_id AS adminID, cr.locality_id AS localityID, cr.relationship_type AS rel,
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
			const adminID = Number(r.adminID)
			const localityID = Number(r.localityID)
			const rel = String(r.rel)

			push(localityID, {
				id: adminID,
				name: String(r.adminName),
				placetype: String(r.adminType),
				relationshipType: rel,
				role: "region",
			})

			push(adminID, {
				id: localityID,
				name: String(r.locName),
				placetype: String(r.locType),
				relationshipType: rel,
				role: "locality",
			})
		}

		return map
	})

	/**
	 * Returns the other admin roles a place holds under the same name, such as Berlin
	 * as both region and locality, in either direction.
	 *
	 * It returns `[]` when the database has no `coincident_roles` table.
	 */
	async coincidentRolesFor(placeID: number): Promise<DualRole[]> {
		if (!Number.isFinite(placeID)) return []

		return (await this.#dualRolesMap()).get(placeID) ?? []
	}

	/**
	 * Fetches the pages the first `findPlace` needs, namely the schema probe, dual-role relation,
	 * abbreviation table and a representative FTS join, so idle time absorbs the cold round trips.
	 * It is idempotent and safe to run alongside real queries.
	 */
	async warmUp(): Promise<void> {
		const { hasPop, hasAbbr } = await this.#schema()

		const stmts = [
			`SELECT spr.id${hasPop ? ", pp.population" : ""} ` +
				`FROM place_search JOIN spr ON spr.id = place_search.wof_id ` +
				`${hasPop ? "LEFT JOIN place_population pp ON pp.id = spr.id " : ""}` +
				`WHERE place_search MATCH '"springfield"' AND spr.is_current != 0 AND spr.is_deprecated = 0 LIMIT 3`,
		]

		if (hasAbbr) {
			stmts.push(`SELECT id FROM place_abbr WHERE abbr = 'ny' COLLATE NOCASE LIMIT 1`)
		}

		await Promise.all([this.#worker.db.exec(stmts.join(";\n")), this.#dualRolesMap()])
	}

	/**
	 * Returns the total bytes range-fetched so far, for live transfer progress.
	 */
	bytesRead(): Promise<number> {
		return this.#worker.bytesRead()
	}

	async #abbrExactIDs(text: string): Promise<Set<number>> {
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
		const fts = sanitizeFTS(text)

		if (!fts) return []
		const limit = Math.max(1, query.limit ?? 10)

		const conds = [`place_search MATCH ${sqlStr(fts)}`, "spr.is_current != 0", "spr.is_deprecated = 0"]

		if (query.placetype) {
			const types = expandPlacetypeFilter(
				(Array.isArray(query.placetype) ? query.placetype : [query.placetype]).filter(isPresent)
			)

			if (types.length) {
				conds.push(`spr.placetype IN (${types.map(sqlStr).join(",")})`)
			}
		}

		if (query.country) {
			conds.push(`spr.country = ${sqlStr(query.country.toUpperCase())}`)
		}

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

		const [rows, abbrIDs] = await Promise.all([this.#worker.db.exec(sql).then(rowsFromExec), this.#abbrExactIDs(text)])
		const normQuery = normName(text)

		const strictExact = (row: Record<string, unknown>): boolean =>
			normName(String(row.name)) === normQuery || abbrIDs.has(Number(row.id))

		const anyStrictExact = rows.some(strictExact)

		return rows
			.map((row) => {
				const pop = typeof row.population === "number" ? row.population : 0
				const popBoost = pop > 0 ? POPULATION_BOOST * Math.min(1, Math.log10(1 + pop) / POPULATION_SCALE_LOG10) : 0
				const adj = (row.bm25 as number) - popBoost

				const aliasExact =
					typeof row.alt_names === "string" && aliasBagExactMatch(row.alt_names, normQuery, anyStrictExact)

				const exactTier = strictExact(row) || aliasExact ? 0 : 1

				return { row, exactTier, adj }
			})
			.toSorted((a, b) => a.exactTier - b.exactTier || a.adj - b.adj)
			.slice(0, limit)
			.map(({ row, adj, exactTier }) => ({
				id: row.id as number,
				name: row.name as string,
				placetype: row.placetype as string,
				lat: row.latitude as number,
				lon: row.longitude as number,
				score: -adj,

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

interface CandidateCodeMaps {
	countryToID: Map<string, number>
	idToCountry: Map<number, string>
	placetypeToID: Map<string, number>
	idToPlacetype: Map<number, string>
}

/**
 * Implements the browser place lookup over the byte-range candidate table,
 * resolving each query with one B-tree probe on `name_key` and no FTS or join.
 *
 * Keys must be normalized with {@link normalizeLocalityForKey}, the same function the build
 * uses, and a parsed region's bbox filters the locality probe by candidate centroid.
 */
export class WOFCandidateTableLookup implements MailwomanLookupLike {
	#worker: HTTPVFSWorker

	constructor(worker: HTTPVFSWorker) {
		this.#worker = worker
	}

	readonly #postalCityPresent = memoizeResettable(() => tableExists(this.#worker, "postal_city_candidate"))

	readonly #columns = memoizeResettable(async (): Promise<Set<string>> => {
		const res = await this.#worker.db.exec(`SELECT name FROM pragma_table_info('candidate')`)

		return new Set(rowsFromExec(res).map((r) => String(r.name)))
	})

	readonly #codeMaps = memoizeResettable(async (): Promise<CandidateCodeMaps> => {
		const cc = rowsFromExec(await this.#worker.db.exec("SELECT id, code FROM country_codes"))
		const pt = rowsFromExec(await this.#worker.db.exec("SELECT id, placetype FROM placetype_codes"))
		const countryToID = new Map<string, number>()
		const idToCountry = new Map<number, string>()

		for (const r of cc) {
			countryToID.set(String(r.code).toUpperCase(), Number(r.id))
			idToCountry.set(Number(r.id), String(r.code).toUpperCase())
		}

		const placetypeToID = new Map<string, number>()
		const idToPlacetype = new Map<number, string>()

		for (const r of pt) {
			placetypeToID.set(String(r.placetype), Number(r.id))
			idToPlacetype.set(Number(r.id), String(r.placetype))
		}

		return { countryToID, idToCountry, placetypeToID, idToPlacetype }
	})

	/**
	 * Fetches the code tables and a representative candidate probe during idle time,
	 * before the first real lookup.
	 */
	async warmUp(): Promise<void> {
		await this.#codeMaps()

		await this.#worker.db.exec(
			`SELECT spr_id, name, latitude, longitude FROM candidate WHERE name_key = 'springfield' ORDER BY neg_rank ASC LIMIT 3`
		)
	}

	/**
	 * Returns the total bytes range-fetched so far, for live transfer progress.
	 */
	bytesRead(): Promise<number> {
		return this.#worker.bytesRead()
	}

	async findPlace(query: Parameters<MailwomanLookupLike["findPlace"]>[0]) {
		const text = (query.text ?? "").trim()

		if (!text) return []
		const nameKey = normalizeLocalityForKey(text)

		if (!nameKey) return []

		const requestedPlacetypes = query.placetype
			? (Array.isArray(query.placetype) ? query.placetype : [query.placetype]).filter(isPresent)
			: []

		const wantsLocality =
			requestedPlacetypes.length === 0 || expandPlacetypeFilter(requestedPlacetypes).includes("locality")

		if (query.postcode && wantsLocality && (await this.#postalCityPresent())) {
			const hit = rowsFromExec(
				await this.#worker.db.exec(
					`SELECT spr_id, name, latitude, longitude FROM postal_city_candidate ` +
						`WHERE name_key = ${sqlStr(nameKey)} AND postcode = ${sqlStr(query.postcode.trim())} LIMIT 1`
				)
			)[0]

			if (hit) {
				return [
					{
						id: Number(hit.spr_id),
						name: String(hit.name ?? ""),
						placetype: "locality",
						country: query.country?.toUpperCase(),
						lat: Number(hit.latitude),
						lon: Number(hit.longitude),
						score: 1,
						exactMatch: true,
						bbox: undefined,
					},
				]
			}
		}

		const limit = Math.max(1, query.limit ?? 10)
		const { countryToID, idToCountry, placetypeToID, idToPlacetype } = await this.#codeMaps()

		const filters: string[] = []

		if (query.country) {
			const cid = countryToID.get(query.country.toUpperCase())

			if (cid === undefined) return []
			filters.push(`country_id = ${cid}`)
		}

		if (requestedPlacetypes.length) {
			const ids = expandPlacetypeFilter(requestedPlacetypes)
				.map((t) => placetypeToID.get(t))
				.filter((v): v is number => v !== undefined)

			if (!ids.length) return []
			filters.push(`placetype_id IN (${ids.join(",")})`)
		}

		if (query.bbox) {
			const b = query.bbox

			filters.push(
				`latitude BETWEEN ${Number(b.minLat)} AND ${Number(b.maxLat)} AND longitude BETWEEN ${Number(b.minLon)} AND ${Number(b.maxLon)}`
			)
		}

		const columns = await this.#columns()

		const optionalSelect = ["population", "is_primary", "importance"]
			.filter((c) => columns.has(c))
			.map((c) => `, ${c}`)
			.join("")

		const probe = async (nk: string): Promise<Array<RankedRow<CandidateProbeRow>>> => {
			const conds = [`name_key = ${sqlStr(nk)}`, ...filters]

			const sql =
				`SELECT spr_id, name, country_id, placetype_id, latitude, longitude, min_lat, min_lon, max_lat, max_lon, neg_rank` +
				`${optionalSelect} FROM candidate WHERE ${conds.join(" AND ")} ORDER BY neg_rank ASC LIMIT ${Math.max(limit, RERANK_FETCH)}`

			const fetched = rowsFromExec<CandidateProbeRow>(await this.#worker.db.exec(sql))

			return rankByPrimaryPreference(fetched, limit, undefined, idToPlacetype)
		}

		let rows = await probe(nameKey)

		if (!rows.length) {
			const strippedKey = normalizeLocalityForKey(stripLocalityQualifier(text))

			if (strippedKey && strippedKey !== nameKey) {
				rows = await probe(strippedKey)
			}
		}

		const candidates = rows.map((row) => {
			const hasBbox = row.min_lat != null && row.max_lat != null && row.min_lon != null && row.max_lon != null

			return {
				id: Number(row.spr_id),
				name: String(row.name ?? ""),
				placetype: idToPlacetype.get(Number(row.placetype_id)) ?? "",

				country: idToCountry.get(Number(row.country_id)),
				lat: Number(row.latitude),
				lon: Number(row.longitude),

				score: -(row.neg_rank as number),
				prominence: -Number(row.effectiveNegRank),

				exactMatch: !row.demoted,

				...(typeof row.population === "number" && row.population > 0
					? { population: row.population, referential: referentialFromPopulation(row.population) }
					: {}),
				...(typeof row.importance === "number" && Number.isFinite(row.importance)
					? { importance: row.importance }
					: {}),
				bbox: hasBbox
					? {
							minLat: Number(row.min_lat),
							maxLat: Number(row.max_lat),
							minLon: Number(row.min_lon),
							maxLon: Number(row.max_lon),
						}
					: undefined,
			}
		})

		if (query.bias && query.bias.length) {
			applyProximityRerank(candidates, query.bias)
		}

		return candidates
	}
}

/**
 * Polygon lookup over an httpvfs worker: id → GeoJSON geometry (async).
 */
export function makeHTTPVFSPolygonLookup(worker: HTTPVFSWorker) {
	return {
		async get(id: number): Promise<unknown | null> {
			const rows = rowsFromExec(await worker.db.exec(`SELECT geom FROM polygons WHERE id = ${Number(id)}`))

			const row = rows[0]

			if (!row) return null

			return tryParsingJSON(String(row.geom))
		},
	}
}
