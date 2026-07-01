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
 *   parity-preference + polyline interpolation in `HttpvfsInterpolator` mirrors
 *   `StreetInterpolator` line-for-line — KEEP THE TWO IN LOCKSTEP (the same lockstep contract the
 *   WOF resolvers hold).
 *
 *   These power the demo's street tier against byte-ranged per-state situs/interp shards: a lookup
 *   touches ~KB of a multi-GB shard (measured, see the spec), so the file size is irrelevant to
 *   query cost.
 */

import { haversineKm } from "@mailwoman/resolver-wof-sqlite/geo"
import {
	canonicalizeRouteKey,
	normalizeLocalityForKey,
	normalizeStreetForKey,
} from "@mailwoman/resolver-wof-sqlite/street-normalize"

/** The minimal worker handle the lookups need — the same shape `loadHttpvfsDB` returns. */
export interface HttpvfsDB {
	db: { exec(sql: string): Promise<Array<{ columns: string[]; values: unknown[][] }>> }
}

/**
 * Inline a string literal for SQL (we inline rather than bind — avoids param marshaling over Comlink).
 */
const sqlStr = (s: string): string => `'${s.replace(/'/g, "''")}'`

/** Sql.js exec result → row objects. */
function rowsFromExec(res: Array<{ columns: string[]; values: unknown[][] }> | undefined): Record<string, unknown>[] {
	if (!res || res.length === 0) return []
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
export class HttpvfsAddressPointLookup {
	#worker: HttpvfsDB
	#available: Promise<boolean> | undefined

	constructor(worker: HttpvfsDB) {
		this.#worker = worker
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
		const streetNorm = normalizeStreetForKey(query.street)
		const number = query.number.trim().toLowerCase()

		if (!streetNorm || !number) return null

		const select = (where: string): string =>
			`SELECT lat, lon, source, release FROM address_point WHERE ${where} LIMIT 1`
		let rows: Record<string, unknown>[] = []

		if (query.postcode) {
			rows = rowsFromExec(
				await this.#worker.db.exec(
					select(
						`postcode = ${sqlStr(query.postcode.trim())} AND street_norm = ${sqlStr(streetNorm)} AND number = ${sqlStr(number)}`
					)
				)
			)
		}

		if (rows.length === 0 && query.locality) {
			rows = rowsFromExec(
				await this.#worker.db.exec(
					select(
						`locality_norm = ${sqlStr(normalizeLocalityForKey(query.locality))} AND street_norm = ${sqlStr(streetNorm)} AND number = ${sqlStr(number)}`
					)
				)
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
export class HttpvfsInterpolator {
	#worker: HttpvfsDB
	#available: Promise<boolean> | undefined

	constructor(worker: HttpvfsDB) {
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

		if (rows.length === 0) return null

		// Parity preference: exact side → 'mixed' → opposite side (flagged). Mirrors StreetInterpolator.
		const wantOdd = n % 2 === 1
		const exact = rows.filter((r) => r.parity === (wantOdd ? "odd" : "even"))
		const mixed = rows.filter((r) => r.parity === "mixed")
		const preferred = exact.length > 0 ? exact : mixed
		const pool = preferred.length > 0 ? preferred : rows
		const parityMatched = preferred.length > 0

		// Tightest range wins.
		const best = pool.reduce((a, b) =>
			Number(b.max_hn) - Number(b.min_hn) < Number(a.max_hn) - Number(a.min_hn) ? b : a
		)
		const polyline = JSON.parse(String(best.geometry)) as [number, number][]
		const span = Number(best.to_hn) - Number(best.from_hn)
		const t = span === 0 ? 0.5 : clamp01((n - Number(best.from_hn)) / span)
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

function clamp01(t: number): number {
	return t < 0 ? 0 : t > 1 ? 1 : t
}

/**
 * Point at fraction `t` of the polyline's arc length (haversine), + total length km. Mirrors StreetInterpolator.
 */
function pointAlong(polyline: readonly [number, number][], t: number): [lon: number, lat: number, lengthKm: number] {
	const legs: number[] = []
	let total = 0

	for (let i = 1; i < polyline.length; i++) {
		const [aLon, aLat] = polyline[i - 1]!
		const [bLon, bLat] = polyline[i]!
		const d = haversineKm(aLat, aLon, bLat, bLon)
		legs.push(d)
		total += d
	}

	if (total === 0) {
		const [lon, lat] = polyline[0]!

		return [lon, lat, 0]
	}
	let remaining = t * total

	for (let i = 0; i < legs.length; i++) {
		const leg = legs[i]!

		if (remaining <= leg || i === legs.length - 1) {
			const f = leg === 0 ? 0 : clamp01(remaining / leg)
			const [aLon, aLat] = polyline[i]!
			const [bLon, bLat] = polyline[i + 1]!

			return [aLon + (bLon - aLon) * f, aLat + (bLat - aLat) * f, total]
		}
		remaining -= leg
	}
	const [lon, lat] = polyline[polyline.length - 1]!

	return [lon, lat, total]
}
