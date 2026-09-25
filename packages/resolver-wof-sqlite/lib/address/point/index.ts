/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file SQLite implementation of core's `AddressPointLookup`.
 */

import type { AddressPointHit, AddressPointLookup } from "@mailwoman/core/resolver"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import type { PathBuilderLike } from "path-ts"

import type { AddressPointDatabase, AddressPointTable } from "#address/point/schema"
import { hasTable, prepareGet, type PreparedGet } from "#sqlite-utils"
import {
	normalizeHouseNumberForKey,
	normalizeLocalityForKey,
	normalizeLocalityForKeyLocale,
	type NameKey,
	type StreetKey,
	streetKeyVariants,
	streetLocaleForSurface,
	stripArrondissement,
	type StreetLocale,
} from "#street/normalize"

/**
 * The columns this lookup reads, typed from the shared {@link AddressPointTable}
 * so a writer-side rename fails to compile here.
 */
type AddressPointRow = Pick<AddressPointTable, "lat" | "lon" | "source" | "release" | "locality_norm" | "postcode">

/**
 * The column list every prepared SELECT uses.
 * It must match the fields of `AddressPointRow`.
 */
const SELECT_COLS = "lat, lon, source, release, locality_norm, postcode"

/**
 * Finds an address point by exact normalized `(street, number)` within a postcode,
 * a locality, or a bounding box.
 *
 * Query normalization uses the extract's `streetLocale`, which must match the
 * locale the extract was built with.
 * Street matching is exact after normalization.
 *
 * Scopes are tried from most to least selective: postcode, locality, locality suffix, then bounding box.
 * When several rows match, any one of them can answer, because unit siblings share the building coordinate.
 */
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
	/**
	 * This query matches the locality key by its suffix, for a `zh` query that gives the 鄉鎮市區 without its 縣市.
	 *
	 * The (street, number) index narrows the rows first, so the `LIKE` scans only rows that share the pair.
	 */
	readonly #byLocalityTail:
		| PreparedGet<[street: StreetKey, number: string, tailPattern: string], AddressPointRow>
		| undefined
	readonly #byBbox:
		| PreparedGet<
				[street: StreetKey, number: string, minLat: number, maxLat: number, minLon: number, maxLon: number],
				AddressPointRow
		  >
		| undefined

	/**
	 * @param dbPath Extract path.
	 * @param opts.streetLocale The street-normalization locale the extract was built with.
	 * A mismatch makes every key miss.
	 * It defaults to `"us"`.
	 * @param opts.localityKeys Whether the extract's `locality_norm` holds full place names.
	 * With `"abbreviated"`, a row's locality can select a row but never rejects one.
	 * The US situs extract uses NAD city fields, which some counties abbreviate
	 * (`addi` for Addison) or replace with the parent town.
	 * It defaults to `"abbreviated"` for `"us"` and `"full"` for every other locale.
	 */
	constructor(
		dbPath: PathBuilderLike,
		opts: { streetLocale?: StreetLocale; localityKeys?: "full" | "abbreviated" } = {}
	) {
		this.#db = new DatabaseClient<DB>(dbPath, { readOnly: true })
		this.#locale = opts.streetLocale ?? "us"
		this.#localityKeys = opts.localityKeys ?? (this.#locale === "us" ? "abbreviated" : "full")

		// An extract without an `address_point` table, such as an interrupted build, makes every lookup miss.
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

			this.#byLocalityTail = prepareGet(
				this.#db,
				`SELECT ${SELECT_COLS} FROM address_point
				 WHERE street_norm = ? AND number = ? AND locality_norm LIKE ? LIMIT 1`
			)
		}
	}

	find(query: {
		street: string
		number: string
		postcode?: string
		locality?: string
		region?: string
		subregion?: string
		bbox?: { minLat: number; maxLat: number; minLon: number; maxLon: number }
	}): AddressPointHit | null {
		if (!this.#byPostcode || !this.#byLocality || !this.#byBbox) return null
		const number = normalizeHouseNumberForKey(query.number, this.#locale)

		if (!number) return null

		// A `zh` extract keys locality as 縣市 + 鄉鎮市區, which the parse tags `region` and `subregion`.
		// The Taiwanese register has no postcode, so this pair becomes the locality key.
		// A query with only the 鄉鎮市區 matches the stored key by its suffix.
		const scoped =
			this.#locale === "zh" && !query.locality && query.subregion
				? query.region
					? { ...query, locality: `${query.region}${query.subregion}` }
					: { ...query, localityTail: normalizeLocalityForKeyLocale(query.subregion, "zh") }
				: query

		// `streetKeyVariants` yields the literal key first.
		// Each variant runs the full number fallback sequence, and the first variant that answers wins.
		let row: AddressPointRow | undefined

		for (const streetNorm of streetKeyVariants(query.street, streetLocaleForSurface(query.street, this.#locale))) {
			row = this.#findForKey(streetNorm, number, scoped)

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
	 * Tries one normalized street key with the exact number, then fallback number forms.
	 * Each fallback runs only after the previous forms missed.
	 */
	#findForKey(
		streetNorm: StreetKey,
		number: string,
		query: {
			street: string
			number: string
			postcode?: string
			locality?: string
			localityTail?: NameKey
			bbox?: { minLat: number; maxLat: number; minLon: number; maxLon: number }
		}
	) {
		let row = this.#probe(streetNorm, number, query)

		// The registers store one number per point, so a range such as "385-387" falls back to its low end.
		if (!row) {
			const low = /^(\d+[a-z]?)-\d+[a-z]?$/.exec(number)?.[1]

			if (low) {
				row = this.#probe(streetNorm, low, query)
			}
		}

		// BAN stores a letter suffix as "3 a", while G-NAF and most OA sources store "3a".
		// For a number of digits plus one letter, the lookup retries the other spacing
		// and then the bare number.
		if (!row) {
			const joined = /^(\d+)\s+([a-z])$/.exec(number)
			const spaced = /^(\d+)([a-z])$/.exec(number)

			if (joined) {
				row = this.#probe(streetNorm, `${joined[1]}${joined[2]}`, query) ?? this.#probe(streetNorm, joined[1]!, query)
			} else if (spaced) {
				row = this.#probe(streetNorm, `${spaced[1]} ${spaced[2]}`, query) ?? this.#probe(streetNorm, spaced[1]!, query)
			}
		}

		// The Taiwanese register stores `14之12` and `30附40` as numbers `14` and `30`, with the rest in `unit`.
		// A query number that still carries the sub-number falls back to the base number, which is approximate.
		if (!row && this.#locale === "zh") {
			const base = /^(\d+)(?:[之附]\d+)+$/u.exec(number)?.[1]

			if (base) {
				row = this.#probe(streetNorm, base, query)
			}
		}

		return row
	}

	/**
	 * Probes one (street, number) key by postcode, then locality, then locality suffix, then bounding box.
	 * Each scope runs only when the previous ones missed.
	 */
	#probe(
		streetNorm: StreetKey,
		number: string,
		query: {
			postcode?: string
			locality?: string
			localityTail?: NameKey
			bbox?: { minLat: number; maxLat: number; minLon: number; maxLon: number }
		}
	): AddressPointRow | undefined {
		let row: AddressPointRow | undefined

		if (query.postcode) {
			const postcode = query.postcode.trim()
			const localityKey = query.locality ? this.#localityKey(query.locality) : undefined

			// One postcode can cover several places with the same street and number,
			// so a row whose locality agrees with the query is tried first.
			// The postcode-only row answers only if `#scopeContradicts` accepts it.
			const agreeing = localityKey ? this.#byPostcodeLocality!(postcode, localityKey, streetNorm, number) : undefined
			const candidate = agreeing ?? this.#byPostcode!(postcode, streetNorm, number)

			row = candidate && !this.#scopeContradicts(candidate, query) ? candidate : undefined
		}

		if (!row && query.locality) {
			row = this.#byLocality!(this.#localityKey(query.locality), streetNorm, number)
		}

		if (!row && query.localityTail && this.#byLocalityTail) {
			// A Han key contains no `%` or `_`, so the pattern matches a literal suffix.
			row = this.#byLocalityTail(streetNorm, number, `%${query.localityTail}`)
		}

		// The bounding box serves extracts whose points have no postcode or locality, such as OSM.
		if (!row && query.bbox) {
			const b = query.bbox
			const candidate = this.#byBbox!(streetNorm, number, b.minLat, b.maxLat, b.minLon, b.maxLon)

			// A row with its own scope that the scoped probes missed is a different address in the same box.
			row = candidate && !this.#scopeContradicts(candidate, query) ? candidate : undefined
		}

		return row
	}

	/**
	 * Folds the query's locality the way the extract's builder folded `locality_norm`.
	 *
	 * FR extracts key arrondissements at the base city, so "Paris 13e Arrondissement"
	 * and "Paris" produce the same key.
	 */
	#localityKey(locality: string): NameKey {
		if (this.#locale === "fr") return stripArrondissement(normalizeLocalityForKey(locality))

		return normalizeLocalityForKeyLocale(locality, this.#locale)
	}

	/**
	 * Returns whether the row's own postcode or locality differs from the query's.
	 *
	 * A row field that is empty never contradicts.
	 * The locality is compared only when the extract's `localityKeys` is `"full"`,
	 * because abbreviated keys would reject correct rows.
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
