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
	readonly #localityLevel: "place" | "finest"
	readonly #byPostcode: PreparedGet<[postcode: string, street: StreetKey, number: string], AddressPointRow> | undefined
	readonly #byPostcodeLocality:
		| PreparedGet<[postcode: string, locality: NameKey, street: StreetKey, number: string], AddressPointRow>
		| undefined
	/**
	 * This query counts the distinct stored localities that hold one (postcode, street, number) key.
	 * Unit siblings share a locality, so they count once.
	 */
	readonly #postcodeKeyPlaces:
		| PreparedGet<[postcode: string, street: StreetKey, number: string], { places: number }>
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
	 * @param opts.localityKeys Whether the extract's `locality_norm` holds full place names.
	 * With `"abbreviated"`, a row's locality can select a row but never rejects one.
	 * The US situs extract uses NAD city fields.
	 * Some counties abbreviate them (`addi` for Addison).
	 * Other counties replace them with the parent town.
	 *
	 * @param opts.localityLevel The kind of place the extract stores in `locality_norm`.
	 * With `"place"`, `locality_norm` holds the place an address line gives, such as a BAN commune.
	 * With `"finest"`, `locality_norm` holds the finest place the source recorded.
	 * That place can be a part of the place the line gives.
	 * The OSM builder stores `addr:suburb` before `addr:city`, so
	 * `Teschener Weg 5, 14163 Berlin` is stored under `zehlendorf`.
	 *
	 * @defaultValue `"us"`
	 * @defaultValue `"abbreviated"` for `"us"` and `"full"` for every other locale.
	 * @defaultValue `"place"`
	 */
	constructor(
		dbPath: PathBuilderLike,
		opts: {
			streetLocale?: StreetLocale
			localityKeys?: "full" | "abbreviated"
			localityLevel?: "place" | "finest"
		} = {}
	) {
		this.#db = new DatabaseClient<DB>(dbPath, { readOnly: true })
		this.#locale = opts.streetLocale ?? "us"
		this.#localityKeys = opts.localityKeys ?? (this.#locale === "us" ? "abbreviated" : "full")
		this.#localityLevel = opts.localityLevel ?? "place"

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

			this.#postcodeKeyPlaces = prepareGet(
				this.#db,
				`SELECT COUNT(DISTINCT locality_norm) AS places FROM address_point
				 WHERE postcode = ? AND street_norm = ? AND number = ?`
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
		bbox: { minLat: number; maxLat: number; minLon: number; maxLon: number } | null
	}): AddressPointHit | null {
		if (!this.#byPostcode || !this.#byLocality || !this.#byBbox) return null
		const number = normalizeHouseNumberForKey(query.number, this.#locale)

		if (!number) return null

		// A `zh` extract keys locality as 縣市 + 鄉鎮市區.
		// The parser tags 縣市 as `region` and 鄉鎮市區 as `subregion`.
		// The Taiwanese register has no postcode, so this pair becomes the locality key.
		// A query with only the 鄉鎮市區 matches the stored key by its suffix.
		const scoped =
			this.#locale === "zh" && !query.locality && query.subregion
				? query.region
					? { ...query, locality: `${query.region}${query.subregion}` }
					: { ...query, localityTail: normalizeLocalityForKeyLocale(query.subregion, "zh") }
				: query

		// `streetKeyVariants` yields the literal key first.
		// Each variant runs the full number fallback sequence.
		// The first variant with a match wins.
		let row: AddressPointRow | null = null

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
			localityNorm: row.locality_norm || null,
			postcode: row.postcode || null,
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
			bbox: { minLat: number; maxLat: number; minLon: number; maxLon: number } | null
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

		// The Taiwanese register stores `14之12` and `30附40` as numbers `14` and `30`.
		// It stores the rest in `unit`.
		// A query number that still includes the sub-number falls back to the base number.
		// That result is approximate.
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
			bbox: { minLat: number; maxLat: number; minLon: number; maxLon: number } | null
		}
	): AddressPointRow | null {
		let row: AddressPointRow | null = null
		// A postcode row stored under a different locality waits until the probe for the query's own locality misses.
		let heldBack: AddressPointRow | null = null

		if (query.postcode) {
			const postcode = query.postcode.trim()
			const localityKey = query.locality ? this.#localityKey(query.locality) : null

			// One postcode can cover several places with the same street and number,
			// so a row whose locality agrees with the query is tried first.
			// The postcode-only row answers only if `#scopeContradicts` accepts it.
			const agreeing = localityKey ? this.#byPostcodeLocality!(postcode, localityKey, streetNorm, number) : null
			const candidate = agreeing ?? this.#byPostcode!(postcode, streetNorm, number)

			if (candidate && !this.#scopeContradicts(candidate, query)) {
				row = candidate
			} else if (candidate && this.#isSublocalityRow(candidate, postcode, streetNorm, number, query.bbox)) {
				heldBack = candidate
			}
		}

		if (!row && query.locality) {
			row = this.#byLocality!(this.#localityKey(query.locality), streetNorm, number)
		}

		if (!row && query.localityTail && this.#byLocalityTail) {
			// A Han key contains no `%` or `_`, so the pattern matches a literal suffix.
			row = this.#byLocalityTail(streetNorm, number, `%${query.localityTail}`)
		}

		if (!row && heldBack) {
			row = heldBack
		}

		// The bounding box serves extracts whose points have no postcode or locality, such as OSM.
		if (!row && query.bbox) {
			const b = query.bbox
			const candidate = this.#byBbox!(streetNorm, number, b.minLat, b.maxLat, b.minLon, b.maxLon)

			// A row with its own scope that the scoped probes missed is a different address in the same box.
			row = candidate && !this.#scopeContradicts(candidate, query) ? candidate : null
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
	 *
	 * Two locality keys agree when they are equal or when one is the leading words of the other.
	 * A German disambiguated name such as `Lauta b Hoyerswerda` or `Freiberg Sachs` begins with the place
	 * name that OSM's `addr:city` records, and a word boundary keeps `lauta` apart from `lautabach`.
	 */
	#scopeContradicts(row: AddressPointRow, query: { postcode?: string; locality?: string }): boolean {
		if (query.postcode && row.postcode && row.postcode.trim() !== query.postcode.trim()) return true

		if (this.#localityKeys === "full" && query.locality && row.locality_norm) {
			const queryKey = this.#localityKey(query.locality)

			const [shorter, longer] =
				row.locality_norm.length <= queryKey.length ? [row.locality_norm, queryKey] : [queryKey, row.locality_norm]

			return shorter !== longer && !longer.startsWith(`${shorter} `)
		}

		return false
	}

	/**
	 * Returns whether a postcode row stored under a different locality lies in a part of the queried place.
	 *
	 * Only an extract whose `localityLevel` is `"finest"` can store a part of a place.
	 * In a `"place"` extract, a different stored locality is a different place.
	 *
	 * In a `"finest"` extract, the row is accepted as part of the queried place when two conditions hold.
	 *
	 * No other stored locality holds the same (postcode, street, number) key.
	 * When the caller supplies the box around the query's resolved locality, the row lies inside it.
	 *
	 * The caller probes the query's own locality before it uses this row.
	 * A postcode key that two places share therefore still answers the place the query gives.
	 */
	#isSublocalityRow(
		row: AddressPointRow,
		postcode: string,
		streetNorm: StreetKey,
		number: string,
		bbox: { minLat: number; maxLat: number; minLon: number; maxLon: number } | null
	): boolean {
		if (this.#localityLevel !== "finest") return false

		if (row.postcode && row.postcode.trim() !== postcode) return false

		if ((this.#postcodeKeyPlaces?.(postcode, streetNorm, number)?.places ?? 0) !== 1) return false

		if (!bbox) return true

		return row.lat >= bbox.minLat && row.lat <= bbox.maxLat && row.lon >= bbox.minLon && row.lon <= bbox.maxLon
	}

	[Symbol.dispose](): void {
		this.#db[Symbol.dispose]()
	}
}
