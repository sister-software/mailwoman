/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file SQLite implementation of core's `StreetCentroidLookup`.
 */

import type { StreetCentroidHit, StreetCentroidLookup } from "@mailwoman/core/resolver"
import { haversineKm } from "@mailwoman/spatial"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import type { PathBuilderLike } from "path-ts"

import { hasTable, prepareGet, type PreparedGet } from "#sqlite-utils"
import type { StreetCentroidDatabase } from "#street/centroid/schema"
import {
	normalizeLocalityForKey,
	normalizeStreetForKeyLocale,
	type NameKey,
	type StreetKey,
	streetLocaleForSurface,
	type StreetLocale,
	stripArrondissement,
} from "#street/normalize"

/**
 * The weighted centroid, extent and provenance that an aggregate probe returns.
 * `lat` is null when no row matched.
 */
interface AggRow {
	lat: number | null
	lon: number | null
	min_lat: number | null
	max_lat: number | null
	min_lon: number | null
	max_lon: number | null
	source: string | null
	release: string | null
}

/**
 * The aggregate columns that weight each row's centroid by `point_count` to
 * reconstruct the combined centroid.
 */
const AGG_SELECT =
	"SUM(lat * point_count) / SUM(point_count) AS lat, " +
	"SUM(lon * point_count) / SUM(point_count) AS lon, " +
	"MIN(min_lat) AS min_lat, MAX(max_lat) AS max_lat, MIN(min_lon) AS min_lon, MAX(max_lon) AS max_lon, " +
	"MAX(source) AS source, MAX(release) AS release"

/**
 * Returns half the bounding-box diagonal in metres, used as a coarse uncertainty
 * radius for a street centroid.
 */
function extentRadiusM(minLat: number, maxLat: number, minLon: number, maxLon: number): number {
	return Math.round(haversineKm(minLat, minLon, maxLat, maxLon) * 500)
}

/**
 * Finds a street's centroid and extent-based uncertainty by street name,
 * scoped by postcode and then by base commune.
 *
 * Each scope aggregates every matching row, so a commune probe returns one centroid
 * over all the postcodes and arrondissements the street spans.
 * Street matching is exact after normalization with the extract's `streetLocale`.
 */
export class StreetCentroidSqliteLookup implements StreetCentroidLookup {
	readonly #db: DatabaseClient<StreetCentroidDatabase>
	readonly #locale: StreetLocale
	readonly #byPostcode: PreparedGet<[postcode: string, street: StreetKey], AggRow> | undefined
	readonly #byLocality: PreparedGet<[locality: NameKey, street: StreetKey], AggRow> | undefined

	/**
	 * @param dbPath Extract path.
	 * @param opts.streetLocale The street-normalization locale the extract was built with.
	 * A mismatch makes every key miss.
	 * It defaults to `"fr"`.
	 */
	constructor(dbPath: PathBuilderLike, opts: { streetLocale?: StreetLocale } = {}) {
		this.#db = new DatabaseClient<StreetCentroidDatabase>(dbPath, { readOnly: true })
		this.#locale = opts.streetLocale ?? "fr"

		// An extract without a `street_centroid` table, such as an interrupted build, makes every lookup miss.
		if (hasTable(this.#db, "street_centroid")) {
			this.#byPostcode = prepareGet(
				this.#db,
				`SELECT ${AGG_SELECT} FROM street_centroid WHERE postcode = ? AND street_norm = ?`
			)

			this.#byLocality = prepareGet(
				this.#db,
				`SELECT ${AGG_SELECT} FROM street_centroid WHERE locality_base = ? AND street_norm = ?`
			)
		}
	}

	find(query: { street: string; postcode?: string; locality?: string }): StreetCentroidHit | null {
		if (!this.#byPostcode || !this.#byLocality) return null
		const streetNorm = normalizeStreetForKeyLocale(query.street, streetLocaleForSurface(query.street, this.#locale))

		if (!streetNorm) return null

		let row: AggRow | undefined

		if (query.postcode?.trim()) {
			row = this.#byPostcode(query.postcode.trim(), streetNorm)
		}

		if ((!row || row.lat == null) && query.locality?.trim()) {
			const base = stripArrondissement(normalizeLocalityForKey(query.locality))
			row = this.#byLocality(base, streetNorm)
		}

		if (!row || row.lat == null || row.lon == null) return null

		return {
			lat: row.lat,
			lon: row.lon,
			uncertaintyM: extentRadiusM(row.min_lat!, row.max_lat!, row.min_lon!, row.max_lon!),
			source: row.source ?? "",
			release: row.release ?? "",
		}
	}

	[Symbol.dispose](): void {
		this.#db[Symbol.dispose]()
	}
}
