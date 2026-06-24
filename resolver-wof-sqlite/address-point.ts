/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   SQLite implementation of core's `AddressPointLookup` (#476): exact `(street, number)` within a
 *   postcode (preferred) or locality scope, against a per-state shard built by
 *   `scripts/build-address-point-shard.ts`. Query-side normalization is THE shared normalizer
 *   (`street-normalize.ts`) — identical to build-side, by construction.
 *
 *   Matching is exact-after-normalization only — no fuzzy street matching in this tier (measure how
 *   far exact gets first; fuzz is a later, separate decision). Postcode scope is attempted first
 *   (cheapest, most selective); locality scope is the fallback. Multiple hits (same number,
 *   units/duplicates) return the first by rowid — coordinates of unit siblings are the same
 *   building for tier purposes.
 */

import { DatabaseSync } from "node:sqlite"

import type { AddressPointHit, AddressPointLookup } from "@mailwoman/resolver"

import type { AddressPointTable } from "./address-point-schema.js"
import { hasTable } from "./sqlite-utils.js"
import { normalizeLocalityForKey, normalizeStreetForKey } from "./street-normalize.js"

/**
 * The columns this lookup projects — a typed slice of the SHARED {@link AddressPointTable}, so a
 * column rename in `build-address-point-shard.ts` (the writer) is a compile error here (the
 * reader).
 */
type AddressPointRow = Pick<AddressPointTable, "lat" | "lon" | "source" | "release">

/**
 * The 4 columns the reader SELECTs, in the schema's order — referenced by the prepared SELECTs so
 * the projected `AddressPointRow` stays in lockstep with the shared schema.
 */
const SELECT_COLS = "lat, lon, source, release"

export class AddressPointSqliteLookup implements AddressPointLookup {
	readonly #db: DatabaseSync
	readonly #byPostcode: ReturnType<DatabaseSync["prepare"]> | undefined
	readonly #byLocality: ReturnType<DatabaseSync["prepare"]> | undefined

	constructor(dbPath: string) {
		this.#db = new DatabaseSync(dbPath, { readOnly: true })
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
		}
	}

	find(query: { street: string; number: string; postcode?: string; locality?: string }): AddressPointHit | null {
		if (!this.#byPostcode || !this.#byLocality) return null
		const streetNorm = normalizeStreetForKey(query.street)
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
		if (!row) return null
		return { lat: row.lat, lon: row.lon, source: row.source, release: row.release }
	}

	close(): void {
		this.#db.close()
	}
}
