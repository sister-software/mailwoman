/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   SQLite implementation of core's `AddressPointLookup` (#476): exact `(street, number)` within a
 *   postcode (preferred), locality, or — for shards whose points carry no scope tag (OSM, #247) —
 *   the resolved locality's BBOX. Query-side normalization is THE shared normalizer
 *   (`street-normalize.ts`), selected per the shard's `streetLocale` so build-side and probe-side
 *   stay identical by construction (US delegates to the USPS pipeline; FR/DE/NL use the locale rules).
 *
 *   Matching is exact-after-normalization only — no fuzzy street matching in this tier (measure how
 *   far exact gets first; fuzz is a later, separate decision). Scope order is most-selective first:
 *   postcode, then locality, then the bbox fall-through (only when a bbox is supplied AND the prior
 *   scopes missed). Multiple hits return the first by rowid — unit siblings share the building coord.
 */

import { DatabaseSync } from "node:sqlite"

import type { AddressPointHit, AddressPointLookup } from "@mailwoman/resolver"

import type { AddressPointTable } from "./address-point-schema.js"
import { hasTable } from "./sqlite-utils.js"
import { normalizeLocalityForKey, normalizeStreetForKeyLocale, type StreetLocale } from "./street-normalize.js"

/**
 * The columns this lookup projects — a typed slice of the SHARED {@link AddressPointTable}, so a column rename in
 * `build-address-point-shard.ts` (the writer) is a compile error here (the reader).
 */
type AddressPointRow = Pick<AddressPointTable, "lat" | "lon" | "source" | "release">

/**
 * The 4 columns the reader SELECTs, in the schema's order — referenced by the prepared SELECTs so the projected
 * `AddressPointRow` stays in lockstep with the shared schema.
 */
const SELECT_COLS = "lat, lon, source, release"

export class AddressPointSqliteLookup implements AddressPointLookup {
	readonly #db: DatabaseSync
	readonly #locale: StreetLocale
	readonly #byPostcode: ReturnType<DatabaseSync["prepare"]> | undefined
	readonly #byLocality: ReturnType<DatabaseSync["prepare"]> | undefined
	readonly #byBbox: ReturnType<DatabaseSync["prepare"]> | undefined

	/**
	 * @param dbPath Shard path.
	 * @param opts.streetLocale The street-normalization locale this shard was BUILT with — must match, or every key
	 *   misses. Defaults to `"us"` (the situs tier), so existing callers are unchanged.
	 */
	constructor(dbPath: string, opts: { streetLocale?: StreetLocale } = {}) {
		this.#db = new DatabaseSync(dbPath, { readOnly: true })
		this.#locale = opts.streetLocale ?? "us"

		// Degrade gracefully on an empty/tableless shard (interrupted build, stray 0-byte file): with no
		// `address_point` table this lookup is a no-op miss, not a crash that loses the whole state (#568).
		if (hasTable(this.#db, "address_point")) {
			this.#byPostcode = this.#db.prepare(
				`SELECT ${SELECT_COLS} FROM address_point
				 WHERE postcode = ? AND street_norm = ? AND number = ? LIMIT 1`
			)
			this.#byLocality = this.#db.prepare(
				`SELECT ${SELECT_COLS} FROM address_point
				 WHERE locality_norm = ? AND street_norm = ? AND number = ? LIMIT 1`
			)
			this.#byBbox = this.#db.prepare(
				`SELECT ${SELECT_COLS} FROM address_point
				 WHERE street_norm = ? AND number = ? AND lat BETWEEN ? AND ? AND lon BETWEEN ? AND ? LIMIT 1`
			)
		}
	}

	find(query: {
		street: string
		number: string
		postcode?: string
		locality?: string
		bbox?: { minLat: number; maxLat: number; minLon: number; maxLon: number }
	}): AddressPointHit | null {
		if (!this.#byPostcode || !this.#byLocality || !this.#byBbox) return null
		const streetNorm = normalizeStreetForKeyLocale(query.street, this.#locale)
		const number = query.number.trim().toLowerCase()

		if (!streetNorm || !number) return null

		let row: AddressPointRow | undefined

		if (query.postcode) {
			row = this.#byPostcode.get(query.postcode.trim(), streetNorm, number) as AddressPointRow | undefined
		}

		if (!row && query.locality) {
			row = this.#byLocality.get(normalizeLocalityForKey(query.locality), streetNorm, number) as
				| AddressPointRow
				| undefined
		}

		// Bbox fall-through (#247): the point carries no postcode/locality of its own, but its coordinate falls
		// inside the resolved locality's box. Only reached when the scoped probes missed AND a bbox was supplied.
		if (!row && query.bbox) {
			const b = query.bbox
			row = this.#byBbox.get(streetNorm, number, b.minLat, b.maxLat, b.minLon, b.maxLon) as AddressPointRow | undefined
		}

		if (!row) return null

		return { lat: row.lat, lon: row.lon, source: row.source, release: row.release }
	}

	close(): void {
		this.#db.close()
	}
}
