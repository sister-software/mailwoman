/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Street-level (situs + interpolation) lookups over a sql.js-httpvfs worker — the browser twins of
 *   `@mailwoman/resolver-wof-sqlite`'s `AddressPointSqliteLookup` (#476) and `StreetInterpolator`
 *   (#483). They run the SAME SQL + the SAME shared normalizer (`street-normalize.ts`) as the node
 *   classes, just ASYNC over the Comlink-proxied worker's `db.exec` (the demo resolves async on the
 *   main thread; see the architecture spec, 2026-06-14-client-side-geocoder-demo-spec.md). The
 *   parity preference and range scoping in `HTTPVFSInterpolator` still mirror `StreetInterpolator`
 *   by hand — KEEP THOSE IN LOCKSTEP (the same contract the WOF resolvers hold). The polyline
 *   geometry no longer needs it: both now call `pointAlong` from `@mailwoman/spatial`.
 *
 *   These power the demo's street tier against byte-ranged per-state situs/interp shards: a lookup
 *   touches ~KB of a multi-GB shard (measured, see the spec), so the file size is irrelevant to
 *   query cost.
 */

import { parseJSONStrict } from "@mailwoman/core/objects"
import { haversineKm } from "@mailwoman/resolver-wof-sqlite/geo"
import {
	canonicalizeRouteKey,
	normalizeLocalityForKey,
	normalizeStreetForKey,
	normalizeStreetForKeyLocale,
	type StreetLocale,
	stripArrondissement,
} from "@mailwoman/resolver-wof-sqlite/street-normalize"
import { clampFraction, pointAlong } from "@mailwoman/spatial"

/**
 * The minimal worker handle the lookups need — the same shape `loadHTTPVFSDatabase` returns.
 */
export interface HTTPVFSDB {
	db: { exec(sql: string): Promise<Array<{ columns: string[]; values: unknown[][] }>> }
}

/**
 * Inline a string literal for SQL (we inline rather than bind — avoids param marshaling over Comlink).
 */
const sqlStr = (s: string): string => `'${s.replaceAll("'", "''")}'`

/**
 * Sql.js exec result → row objects.
 */
function rowsFromExec(res: Array<{ columns: string[]; values: unknown[][] }> | undefined): Record<string, unknown>[] {
	if (!res || !res.length) return []
	const { columns, values } = res[0]!

	return values.map((row) => Object.fromEntries(columns.map((c, i) => [c, row[i]])))
}

export interface StreetPointHit {
	lat: number
	lon: number
	source: string
	release: string
}

/**
 * Exact situs point — async twin of `AddressPointSqliteLookup`. Postcode scope first, locality fallback.
 */
export class HTTPVFSAddressPointLookup {
	#worker: HTTPVFSDB
	#available: Promise<boolean> | undefined
	#locale: StreetLocale

	/**
	 * `streetLocale` must match the shard's build locale (the node class's contract) — default "us".
	 */
	constructor(worker: HTTPVFSDB, opts: { streetLocale?: StreetLocale } = {}) {
		this.#worker = worker
		this.#locale = opts.streetLocale ?? "us"
	}

	/**
	 * One round trip to confirm the shard carries `address_point` (graceful on a tableless shard, #568).
	 */
	#hasTable(): Promise<boolean> {
		if (!this.#available) {
			this.#available = this.#worker.db
				.exec(`SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='address_point'`)
				.then((res) => Number(rowsFromExec(res)[0]?.n) > 0)

			this.#available.catch(() => {
				this.#available = undefined
			})
		}

		return this.#available
	}

	async find(query: {
		street: string
		number: string
		postcode?: string
		locality?: string
	}): Promise<StreetPointHit | null> {
		if (!(await this.#hasTable())) return null
		const streetNorm = normalizeStreetForKeyLocale(query.street, this.#locale)
		const number = query.number.trim().toLowerCase()

		if (!streetNorm || !number) return null

		const select = (where: string): string =>
			`SELECT lat, lon, source, release FROM address_point WHERE ${where} LIMIT 1`

		let rows: Record<string, unknown>[] = []

		/**
		 * Run one address-point probe and hand back its rows.
		 */
		const probe = async (where: string): Promise<Record<string, unknown>[]> =>
			rowsFromExec(await this.#worker.db.exec(select(where)))

		if (query.postcode) {
			rows = await probe(
				`postcode = ${sqlStr(query.postcode.trim())} AND street_norm = ${sqlStr(streetNorm)} AND number = ${sqlStr(number)}`
			)
		}

		if (!rows.length && query.locality) {
			// FR shards fold arrondissement communes to the base city on both sides (the node class +
			// BAN builder discipline) — mirror it here so the twins stay in lockstep.
			const localityKey =
				this.#locale === "fr"
					? stripArrondissement(normalizeLocalityForKey(query.locality))
					: normalizeLocalityForKey(query.locality)

			rows = await probe(
				`locality_norm = ${sqlStr(localityKey)} AND street_norm = ${sqlStr(streetNorm)} AND number = ${sqlStr(number)}`
			)
		}

		const r = rows[0]

		if (!r) return null

		return { lat: Number(r.lat), lon: Number(r.lon), source: String(r.source), release: String(r.release) }
	}
}

export interface StreetInterpHit {
	lat: number
	lon: number
	interpolated: true
	method: "tiger_range"
	parityMatched: boolean
	uncertaintyM: number
	source: string
	release: string
}

/**
 * TIGER-range interpolation — async twin of `StreetInterpolator`. Postcode-scoped; abstains on cross-ZIP ambiguity.
 */
export class HTTPVFSInterpolator {
	#worker: HTTPVFSDB
	#available: Promise<boolean> | undefined

	constructor(worker: HTTPVFSDB) {
		this.#worker = worker
	}

	#hasTable(): Promise<boolean> {
		if (!this.#available) {
			this.#available = this.#worker.db
				.exec(`SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='street_segment'`)
				.then((res) => Number(rowsFromExec(res)[0]?.n) > 0)

			this.#available.catch(() => {
				this.#available = undefined
			})
		}

		return this.#available
	}

	async find(query: { street: string; number: string; postcode?: string }): Promise<StreetInterpHit | null> {
		if (!(await this.#hasTable())) return null
		const streetNorm = canonicalizeRouteKey(normalizeStreetForKey(query.street))
		const numberRaw = query.number.trim()

		if (!streetNorm || !/^\d+$/.test(numberRaw)) return null
		const n = Number(numberRaw)
		const cols = `from_hn, to_hn, min_hn, max_hn, parity, postcode, geometry, source, release`

		let rows: Record<string, unknown>[]

		if (query.postcode) {
			rows = rowsFromExec(
				await this.#worker.db.exec(
					`SELECT ${cols} FROM street_segment WHERE postcode = ${sqlStr(query.postcode.trim())} AND street_norm = ${sqlStr(streetNorm)} AND min_hn <= ${n} AND max_hn >= ${n}`
				)
			)
		} else {
			rows = rowsFromExec(
				await this.#worker.db.exec(
					`SELECT ${cols} FROM street_segment WHERE street_norm = ${sqlStr(streetNorm)} AND min_hn <= ${n} AND max_hn >= ${n}`
				)
			)

			// No scope: a name matching ranges across several ZIPs is ambiguous — abstain.
			if (new Set(rows.map((r) => String(r.postcode ?? ""))).size > 1) return null
		}

		if (!rows.length) return null

		// Parity preference: exact side → 'mixed' → opposite side (flagged). Mirrors StreetInterpolator.
		const wantOdd = n % 2 === 1
		const exact = rows.filter((r) => r.parity === (wantOdd ? "odd" : "even"))
		const mixed = rows.filter((r) => r.parity === "mixed")
		const preferred = exact.length ? exact : mixed
		const pool = preferred.length ? preferred : rows
		const parityMatched = preferred.length > 0

		// Tightest range wins.
		const spanOf = (row: Record<string, unknown>): number => Number(row.max_hn) - Number(row.min_hn)
		let best = pool[0]!

		for (const candidate of pool) {
			if (spanOf(candidate) < spanOf(best)) {
				best = candidate
			}
		}

		const polyline = parseJSONStrict<[number, number][]>(String(best.geometry))
		const span = Number(best.to_hn) - Number(best.from_hn)
		const t = span === 0 ? 0.5 : clampFraction((n - Number(best.from_hn)) / span)
		const [lon, lat, lengthKm] = pointAlong(polyline, t)

		return {
			lat,
			lon,
			interpolated: true,
			method: "tiger_range",
			parityMatched,
			uncertaintyM: Math.round((lengthKm * 1000) / 2),
			source: String(best.source),
			release: String(best.release),
		}
	}
}
