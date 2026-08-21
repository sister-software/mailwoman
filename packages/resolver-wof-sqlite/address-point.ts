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

import type { AddressPointTable } from "./address-point-schema.ts"
import { hasTable, prepareGet, type PreparedGet } from "./sqlite-utils.ts"
import {
	normalizeLocalityForKey,
	type NameKey,
	type StreetKey,
	streetKeyVariants,
	streetLocaleForSurface,
	stripArrondissement,
	type StreetLocale,
} from "./street-normalize.ts"

/**
 * The columns this lookup projects — a typed slice of the SHARED {@link AddressPointTable}, so a column rename in
 * `build-address-point-shard.ts` (the writer) is a compile error here (the reader).
 */
type AddressPointRow = Pick<AddressPointTable, "lat" | "lon" | "source" | "release" | "locality_norm" | "postcode">

/**
 * The 4 columns the reader SELECTs, in the schema's order — referenced by the prepared SELECTs so the projected
 * `AddressPointRow` stays in lockstep with the shared schema.
 */
const SELECT_COLS = "lat, lon, source, release, locality_norm, postcode"

export class AddressPointSqliteLookup implements AddressPointLookup {
	readonly #db: DatabaseSync
	readonly #locale: StreetLocale
	readonly #byPostcode: PreparedGet<[postcode: string, street: StreetKey, number: string], AddressPointRow> | undefined
	readonly #byLocality: PreparedGet<[locality: NameKey, street: StreetKey, number: string], AddressPointRow> | undefined
	readonly #byBbox:
		| PreparedGet<
				[street: StreetKey, number: string, minLat: number, maxLat: number, minLon: number, maxLon: number],
				AddressPointRow
		  >
		| undefined

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
			this.#byPostcode = prepareGet(
				this.#db,
				`SELECT ${SELECT_COLS} FROM address_point
				 WHERE postcode = ? AND street_norm = ? AND number = ? LIMIT 1`
			)

			this.#byLocality = prepareGet(
				this.#db,
				`SELECT ${SELECT_COLS} FROM address_point
				 WHERE locality_norm = ? AND street_norm = ? AND number = ? LIMIT 1`
			)

			this.#byBbox = prepareGet(
				this.#db,
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
		const number = query.number.trim().toLowerCase()

		if (!number) return null

		// Key-variant ladder (see `streetKeyVariants`): the literal key first, then the doubled-type
		// collapse and the saint↔st register swap — each variant runs the FULL number ladder below, and
		// the first variant to answer wins, so an attested literal key is never second-guessed.
		let row: AddressPointRow | undefined

		for (const streetNorm of streetKeyVariants(query.street, streetLocaleForSurface(query.street, this.#locale))) {
			row = this.#findForKey(streetNorm, number, query)

			if (row) break
		}

		if (!row) return null

		return {
			lat: row.lat,
			lon: row.lon,
			source: row.source,
			release: row.release,
			...(row.locality_norm ? { localityNorm: row.locality_norm } : {}),
			...(row.postcode ? { postcode: row.postcode } : {}),
		}
	}

	/**
	 * The full number ladder for ONE normalized street key: exact, then the range low-end, then letter-suffix spacing
	 * with the base-number fall — see each rung's note in place.
	 */
	#findForKey(
		streetNorm: StreetKey,
		number: string,
		query: {
			street: string
			number: string
			postcode?: string
			locality?: string
			bbox?: { minLat: number; maxLat: number; minLon: number; maxLon: number }
		}
	) {
		let row = this.#probe(streetNorm, number, query)

		// Range-surface fallback: every register this reader serves stores ONE number per point
		// (G-NAF `NUMBER_FIRST`, BAN, OA, OSM `addr:housenumber`), but the attested surface is often
		// a range — "385-387 Esplanade" keys `385`. Null-only: an exact range key that matched above
		// (some OSM points DO carry "385-387" verbatim) is never second-guessed.
		if (!row) {
			const low = /^(\d+[a-z]?)-\d+[a-z]?$/.exec(number)?.[1]

			if (low) {
				row = this.#probe(streetNorm, low, query)
			}
		}

		// Letter-suffix spacing fallback: the registers disagree on the joint — BAN stores "3 a"
		// (space-separated), G-NAF and most OA sources store "3a" — and the parsed surface can arrive
		// either way. On a miss, retry the OTHER spacing; on a double miss, the BASE number (the
		// register attests no 3A but does attest 3 — the adjacent-parcel approximation, priced the
		// same as the range fallback's low end). Null-only throughout, and only for the
		// digits+single-letter shape (never touches "12 1/2" or unit-bearing forms).
		if (!row) {
			const joined = /^(\d+)\s+([a-z])$/.exec(number)
			const spaced = /^(\d+)([a-z])$/.exec(number)

			if (joined) {
				row = this.#probe(streetNorm, `${joined[1]}${joined[2]}`, query) ?? this.#probe(streetNorm, joined[1]!, query)
			} else if (spaced) {
				row = this.#probe(streetNorm, `${spaced[1]} ${spaced[2]}`, query) ?? this.#probe(streetNorm, spaced[1]!, query)
			}
		}

		return row
	}

	/**
	 * The scope ladder for one (street, number) key: postcode, then locality, then the bbox fall-through — each rung only
	 * when the prior missed.
	 */
	#probe(
		streetNorm: StreetKey,
		number: string,
		query: {
			postcode?: string
			locality?: string
			bbox?: { minLat: number; maxLat: number; minLon: number; maxLon: number }
		}
	): AddressPointRow | undefined {
		let row: AddressPointRow | undefined

		if (query.postcode) {
			row = this.#byPostcode!(query.postcode.trim(), streetNorm, number)
		}

		if (!row && query.locality) {
			// FR shards key arrondissement communes at the base city (both-sides fold, see the BAN
			// builder + stripArrondissement) — fold the probe too so "Paris 13e Arrondissement" and
			// "Paris" both hit. No-op for "us" shards and every non-arrondissement commune.
			const localityKey =
				this.#locale === "fr"
					? stripArrondissement(normalizeLocalityForKey(query.locality))
					: normalizeLocalityForKey(query.locality)

			row = this.#byLocality!(localityKey, streetNorm, number)
		}

		// Bbox fall-through (#247): the point carries no postcode/locality of its own, but its coordinate falls
		// inside the resolved locality's box. Only reached when the scoped probes missed AND a bbox was supplied.
		if (!row && query.bbox) {
			const b = query.bbox
			row = this.#byBbox!(streetNorm, number, b.minLat, b.maxLat, b.minLon, b.maxLon)
		}

		return row
	}

	close(): void {
		this.#db.close()
	}
}
