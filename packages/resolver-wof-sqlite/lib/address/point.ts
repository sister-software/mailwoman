/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   SQLite implementation of core's `AddressPointLookup` (#476): exact `(street, number)` within a
 *   postcode (preferred), locality, or — for extracts whose points carry no scope tag (OSM, #247) —
 *   the resolved locality's BBOX. Query-side normalization is THE shared normalizer
 *   (`street-normalize.ts`), selected per the extract's `streetLocale` so build-side and probe-side
 *   stay identical by construction (US delegates to the USPS pipeline; FR/DE/NL use the locale rules).
 *
 *   Matching is exact-after-normalization only — no fuzzy street matching in this tier (measure how
 *   far exact gets first; fuzz is a later, separate decision). Scope order is most-selective first:
 *   postcode, then locality, then the bbox fall-through (only when a bbox is supplied AND the prior
 *   scopes missed). Multiple hits return the first by rowid — unit siblings share the building coord.
 */

import type { AddressPointHit, AddressPointLookup } from "@mailwoman/core/resolver"
import { DatabaseClient } from "@mailwoman/sqlite/client"

import type { AddressPointDatabase, AddressPointTable } from "#address/point-schema"
import { hasTable, prepareGet, type PreparedGet } from "#sqlite-utils"
import {
	normalizeLocalityForKey,
	type NameKey,
	type StreetKey,
	streetKeyVariants,
	streetLocaleForSurface,
	stripArrondissement,
	type StreetLocale,
} from "#street/normalize"

/**
 * The columns this lookup projects — a typed slice of the SHARED {@link AddressPointTable}, so a column rename in
 * `build-address-point-extract.ts` (the writer) is a compile error here (the reader).
 */
type AddressPointRow = Pick<AddressPointTable, "lat" | "lon" | "source" | "release" | "locality_norm" | "postcode">

/**
 * The 4 columns the reader SELECTs, in the schema's order — referenced by the prepared SELECTs so the projected
 * `AddressPointRow` stays in lockstep with the shared schema.
 */
const SELECT_COLS = "lat, lon, source, release, locality_norm, postcode"

export class AddressPointSqliteLookup<DB extends AddressPointDatabase = AddressPointDatabase>
	implements AddressPointLookup, Disposable
{
	readonly #db: DatabaseClient<DB>
	readonly #locale: StreetLocale
	readonly #localityKeys: "full" | "abbreviated"
	readonly #byPostcode: PreparedGet<[postcode: string, street: StreetKey, number: string], AddressPointRow> | undefined
	readonly #byPostcodeLocality:
		| PreparedGet<[postcode: string, locality: NameKey, street: StreetKey, number: string], AddressPointRow>
		| undefined
	readonly #byLocality: PreparedGet<[locality: NameKey, street: StreetKey, number: string], AddressPointRow> | undefined
	readonly #byBbox:
		| PreparedGet<
				[street: StreetKey, number: string, minLat: number, maxLat: number, minLon: number, maxLon: number],
				AddressPointRow
		  >
		| undefined

	/**
	 * @param dbPath Extract path.
	 * @param opts.streetLocale The street-normalization locale this extract was BUILT with — must match, or every key
	 *   misses. Defaults to `"us"` (the situs tier), so existing callers are unchanged.
	 * @param opts.localityKeys Whether the extract's `locality_norm` is a FULL place name a query can be held to. The BAN
	 *   and OSM extracts write the commune or `addr:city` in full; the US situs extract writes the NAD city field, which
	 *   several counties abbreviate (`addi` for Addison on 5,174 Texas rows, 327,264 Texas rows at four characters or
	 *   fewer) or give as the parent town (`easton` for North Easton). A key like that can steer WHICH row answers but
	 *   cannot refuse one, so it never contradicts. Defaults from the street locale: `"us"` is abbreviated, the rest
	 *   full.
	 */
	constructor(dbPath: string, opts: { streetLocale?: StreetLocale; localityKeys?: "full" | "abbreviated" } = {}) {
		this.#db = new DatabaseClient<DB>(dbPath, { readOnly: true })
		this.#locale = opts.streetLocale ?? "us"
		this.#localityKeys = opts.localityKeys ?? (this.#locale === "us" ? "abbreviated" : "full")

		// Degrade gracefully on an empty/tableless extract (interrupted build, stray 0-byte file): with no
		// `address_point` table this lookup is a no-op miss, not a crash that loses the whole state (#568).
		if (hasTable(this.#db, "address_point")) {
			this.#byPostcode = prepareGet(
				this.#db,
				`SELECT ${SELECT_COLS} FROM address_point
				 WHERE postcode = ? AND street_norm = ? AND number = ? LIMIT 1`
			)

			this.#byPostcodeLocality = prepareGet(
				this.#db,
				`SELECT ${SELECT_COLS} FROM address_point
				 WHERE postcode = ? AND locality_norm = ? AND street_norm = ? AND number = ? LIMIT 1`
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
			const postcode = query.postcode.trim()
			const localityKey = query.locality ? this.#localityKey(query.locality) : undefined

			// A postcode can span several places — DE 04509 covers Schönwölkau and Werlitzsch, both with a Teichstraße 3 —
			// so when the query names a locality the row whose own locality agrees is asked for FIRST. Only when no such
			// row exists does the postcode-only row answer, and then only if its locality does not name a different place
			// (see `#scopeContradicts` for what "different" tolerates): a query naming a third village under the postcode
			// falls through to the locality rung rather than answering the wrong rooftop.
			const agreeing = localityKey ? this.#byPostcodeLocality!(postcode, localityKey, streetNorm, number) : undefined
			const candidate = agreeing ?? this.#byPostcode!(postcode, streetNorm, number)

			row = candidate && !this.#scopeContradicts(candidate, query) ? candidate : undefined
		}

		if (!row && query.locality) {
			// FR extracts key arrondissement communes at the base city (both-sides fold, see the BAN
			// builder + stripArrondissement) — fold the probe too so "Paris 13e Arrondissement" and
			// "Paris" both hit. No-op for "us" extracts and every non-arrondissement commune.
			row = this.#byLocality!(this.#localityKey(query.locality), streetNorm, number)
		}

		// Bbox fall-through (#247): the point carries no postcode/locality of its own, but its coordinate falls
		// inside the resolved locality's box. Only reached when the scoped probes missed AND a bbox was supplied.
		if (!row && query.bbox) {
			const b = query.bbox
			const candidate = this.#byBbox!(streetNorm, number, b.minLat, b.maxLat, b.minLon, b.maxLon)

			// A register row that carries its own scope and was NOT found by the scoped rungs is a different address that
			// happens to share the street and number inside the box: `10 rue de la République, 75008 Paris` reached
			// Servon's `10 rue de la République` (postcode 77170) 26 km away this way, at rooftop tier and 1 m uncertainty.
			// The rung exists for points with no scope of their own; a point whose scope disagrees with the query is a miss.
			row = candidate && !this.#scopeContradicts(candidate, query) ? candidate : undefined
		}

		return row
	}

	/**
	 * The query's locality folded the way the extract's builder folded its `locality_norm`. FR extracts key
	 * arrondissement communes at the base city (both-sides fold, see the BAN builder + stripArrondissement), so "Paris
	 * 13e Arrondissement" and "Paris" both hit; a no-op for every other locale.
	 */
	#localityKey(locality: string): NameKey {
		return this.#locale === "fr"
			? stripArrondissement(normalizeLocalityForKey(locality))
			: normalizeLocalityForKey(locality)
	}

	/**
	 * Whether a row's OWN postcode or locality names a different place than the query did. Absent scope on the row is not
	 * a contradiction — it is the case the bbox rung was built for — and a rung that matched ON a field cannot contradict
	 * it, so at the postcode rung only the locality can disagree and at the bbox rung either can.
	 *
	 * The locality is consulted only on an extract whose keys are full names (the constructor's `localityKeys`). Under
	 * exact comparison against the US extract's abbreviated keys, the postcode rung refused `4900 Airport Pkwy, Addison
	 * TX 75001`'s own rooftop row (`addi`) and `678 Depot St, North Easton, MA 02356`'s (`easton`), and both `pass` board
	 * rows fell to interpolation 144–198 m away — invisible to a 1 km grade (#2155). `servon` against `paris` and
	 * `werlitzsch` against `krensitz`, on the BAN and OSM extracts, are different places and still refuse.
	 */
	#scopeContradicts(row: AddressPointRow, query: { postcode?: string; locality?: string }): boolean {
		if (query.postcode && row.postcode && row.postcode.trim() !== query.postcode.trim()) return true

		if (this.#localityKeys === "full" && query.locality && row.locality_norm) {
			return row.locality_norm !== this.#localityKey(query.locality)
		}

		return false
	}

	[Symbol.dispose](): void {
		this.#db[Symbol.dispose]()
	}
}
