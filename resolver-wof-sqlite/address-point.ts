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

import type { AddressPointHit, AddressPointLookup } from "@mailwoman/core/resolver"

import { normalizeLocalityForKey, normalizeStreetForKey } from "./street-normalize.js"

interface AddressPointRow {
	lat: number
	lon: number
	source: string
	release: string
}

export class AddressPointSqliteLookup implements AddressPointLookup {
	readonly #db: DatabaseSync
	readonly #byPostcode
	readonly #byLocality

	constructor(dbPath: string) {
		this.#db = new DatabaseSync(dbPath, { readOnly: true })
		this.#byPostcode = this.#db.prepare(
			`SELECT lat, lon, source, release FROM address_point
			 WHERE postcode = ? AND street_norm = ? AND number = ? LIMIT 1`
		)
		this.#byLocality = this.#db.prepare(
			`SELECT lat, lon, source, release FROM address_point
			 WHERE locality_norm = ? AND street_norm = ? AND number = ? LIMIT 1`
		)
	}

	find(query: { street: string; number: string; postcode?: string; locality?: string }): AddressPointHit | null {
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
