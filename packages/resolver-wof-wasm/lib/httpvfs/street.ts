/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Street-level (situs and interpolation) lookups over a sql.js-httpvfs worker, the browser twins of
 * `@mailwoman/resolver-wof-sqlite`'s `AddressPointSqliteLookup` and `StreetInterpolator`. They run the
 * same SQL and shared normalizers as the node classes, async over the Comlink-proxied worker's
 * `db.exec`. `HTTPVFSInterpolator` must keep its parity preference and range scoping in lockstep with
 * `StreetInterpolator`.
 */

import { parseJSONStrict } from "@mailwoman/core/json"
import {
	canonicalizeRouteKey,
	normalizeLocalityForKey,
	normalizeStreetForKey,
	normalizeStreetForKeyLocale,
	type StreetLocale,
	stripArrondissement,
} from "@mailwoman/resolver-wof-sqlite/street/normalize"
import { clampFraction, pointAlong } from "@mailwoman/spatial"

import { memoizeResettable, rowsFromExec, tableExists } from "#httpvfs/rows"

/**
 * The minimal worker handle the lookups need, the same shape `loadHTTPVFSDatabase` returns.
 */
export interface HTTPVFSDB {
	db: { exec(sql: string): Promise<Array<{ columns: string[]; values: unknown[][] }>> }
}

/**
 * Inline a string literal for SQL.
 * Inlining avoids param marshaling over Comlink.
 */
const sqlStr = (s: string): string => `'${s.replaceAll("'", "''")}'`

export interface StreetPointHit {
	lat: number
	lon: number
	source: string
	release: string
}

/**
 * Exact situs point, the async twin of `AddressPointSqliteLookup`.
 *
 * Postcode scope first, locality fallback.
 */
export class HTTPVFSAddressPointLookup {
	#worker: HTTPVFSDB
	/**
	 * One memoized round trip to confirm the extract carries `address_point`,
	 * graceful on a tableless extract.
	 */
	readonly #hasTable: () => Promise<boolean>
	#locale: StreetLocale

	/**
	 * `streetLocale` must match the extract's build locale (the node class's interface).
	 * Default "us".
	 */
	constructor(worker: HTTPVFSDB, opts: { streetLocale?: StreetLocale } = {}) {
		this.#worker = worker
		this.#hasTable = memoizeResettable(() => tableExists(worker, "address_point"))
		this.#locale = opts.streetLocale ?? "us"
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
			// FR extracts fold arrondissement communes to the base city on both sides
			// (the node class and BAN builder discipline), so mirror it here to keep the twins in lockstep.
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
 * Tiger-range interpolation, the async twin of `StreetInterpolator`.
 *
 * Postcode-scoped, abstaining on cross-ZIP ambiguity.
 */
export class HTTPVFSInterpolator {
	#worker: HTTPVFSDB
	/**
	 * One memoized round trip to confirm the extract carries `street_segment`.
	 */
	readonly #hasTable: () => Promise<boolean>

	constructor(worker: HTTPVFSDB) {
		this.#worker = worker
		this.#hasTable = memoizeResettable(() => tableExists(worker, "street_segment"))
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

			// No scope: a name matching ranges across several ZIPs is ambiguous, so abstain.
			if (new Set(rows.map((r) => String(r.postcode ?? ""))).size > 1) return null
		}

		if (!rows.length) return null

		// Parity preference: exact side, then 'mixed', then opposite side (flagged).
		// Mirrors StreetInterpolator.
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

/**
 * A street-level coordinate, the tier that produced it, and an uncertainty radius.
 */
export interface StreetResolution {
	lat: number
	lon: number
	tier: "address_point" | "interpolated"
	/**
	 * Calibrated uncertainty radius in meters, 10 m on the situs floor
	 * and `uncertaintyM` times the region factor for interpolation.
	 */
	uncertaintyM: number
}

/**
 * Structural shapes so this is testable with stubs (and decoupled from the lookup classes above).
 */
interface SitusLike {
	find(q: {
		street: string
		number: string
		postcode?: string
		locality?: string
	}): Promise<{ lat: number; lon: number } | null>
}

interface InterpLike {
	find(q: {
		street: string
		number: string
		postcode?: string
	}): Promise<{ lat: number; lon: number; uncertaintyM: number } | null>
}

/**
 * Street tier: exact situs point first (10 m floor), then tiger interpolation (calibrated radius),
 * else null so the caller falls back to the admin cascade ({@link runCascade}).
 *
 * The tier order mirrors the node `geocode-core` path (address_point, then interpolated, then admin),
 * async on the main thread.
 * `interpRadiusCalibration` is the per-region conformal factor
 * (`data/calibration/interp-radius-conformal.json`) with a default of 1.95,
 * the conservative national default where under-coverage is the harmful error.
 */
export async function resolveStreet(
	street: string | undefined,
	houseNumber: string | undefined,
	postcode: string | undefined,
	locality: string | undefined,
	situs: SitusLike | undefined,
	interp: InterpLike | undefined,
	interpRadiusCalibration = 1.95
): Promise<StreetResolution | null> {
	const st = (street ?? "").trim()
	const num = (houseNumber ?? "").trim()

	if (!st || !num) return null

	if (situs) {
		const hit = await situs.find({ street: st, number: num, postcode, locality })

		if (hit && !(hit.lat === 0 && hit.lon === 0)) {
			return { lat: hit.lat, lon: hit.lon, tier: "address_point", uncertaintyM: 10 }
		}
	}

	if (interp) {
		const hit = await interp.find({ street: st, number: num, postcode })

		if (hit && !(hit.lat === 0 && hit.lon === 0)) {
			return {
				lat: hit.lat,
				lon: hit.lon,
				tier: "interpolated",
				uncertaintyM: Math.round(hit.uncertaintyM * interpRadiusCalibration),
			}
		}
	}

	return null
}
