/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   SQLite implementation of core's `StreetCentroidLookup` (#1042): the street-level tier BELOW the
 *   exact address-point tier and ABOVE admin-centroid resolution. Given a street name (no house
 *   number) plus a postcode/commune scope, it returns the street's CENTROID + an honest extent-derived
 *   uncertainty from the derived `street-centroids-<cc>.db` roll-up.
 *
 *   Query-side normalization is THE shared normalizer (`street-normalize.ts`), selected per the shard's
 *   `streetLocale`, so build-side and probe-side keys agree by construction. The commune scope folds
 *   through `normalizeLocalityForKey` + `stripArrondissement` (BAN names Paris/Lyon/Marseille per
 *   arrondissement; a query names the base commune).
 *
 *   Scope order is most-selective first: `postcode`, then the base commune. Each scope WEIGHTED-
 *   aggregates (by `point_count`) across the matched rows in SQL, so a commune-scope probe returns the
 *   street's grand centroid over every postcode/arrondissement it spans — one row, one hit. Matching is
 *   exact-after-normalization only (no fuzzy street matching in this tier).
 */

import { DatabaseSync } from "node:sqlite"

import type { StreetCentroidHit, StreetCentroidLookup } from "@mailwoman/resolver"

import { hasTable } from "./sqlite-utils.ts"
import {
	normalizeLocalityForKey,
	normalizeStreetForKeyLocale,
	type StreetLocale,
	stripArrondissement,
} from "./street-normalize.ts"

/** The weighted-centroid + extent + provenance an aggregate probe projects. `lat` is null when nothing matched. */
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

/** Weighted-centroid aggregate over a WHERE-filtered set. `SUM(coord*n)/SUM(n)` reconstructs the grand centroid. */
const AGG_SELECT =
	"SUM(lat * point_count) / SUM(point_count) AS lat, " +
	"SUM(lon * point_count) / SUM(point_count) AS lon, " +
	"MIN(min_lat) AS min_lat, MAX(max_lat) AS max_lat, MIN(min_lon) AS min_lon, MAX(max_lon) AS max_lon, " +
	"MAX(source) AS source, MAX(release) AS release"

/** Half the bbox diagonal, in METERS — an honest coarse radius for a street centroid. */
function extentRadiusM(minLat: number, maxLat: number, minLon: number, maxLon: number): number {
	const R = 6_371_000
	const toRad = (d: number): number => (d * Math.PI) / 180
	const dLat = toRad(maxLat - minLat)
	const dLon = toRad(maxLon - minLon)
	const midLat = toRad((minLat + maxLat) / 2)
	const a = Math.sin(dLat / 2) ** 2 + Math.cos(midLat) ** 2 * Math.sin(dLon / 2) ** 2
	const diag = 2 * R * Math.asin(Math.min(1, Math.sqrt(a)))

	return Math.round(diag / 2)
}

export class StreetCentroidSqliteLookup implements StreetCentroidLookup {
	readonly #db: DatabaseSync
	readonly #locale: StreetLocale
	readonly #byPostcode: ReturnType<DatabaseSync["prepare"]> | undefined
	readonly #byLocality: ReturnType<DatabaseSync["prepare"]> | undefined

	/**
	 * @param dbPath Shard path.
	 * @param opts.streetLocale The street-normalization locale this shard was BUILT with — must match, or every key
	 *   misses. Defaults to `"fr"` (BAN is the French national register; the tier is FR-only today).
	 */
	constructor(dbPath: string, opts: { streetLocale?: StreetLocale } = {}) {
		this.#db = new DatabaseSync(dbPath, { readOnly: true })
		this.#locale = opts.streetLocale ?? "fr"

		// Degrade gracefully on an empty/tableless shard (interrupted build, stray 0-byte file): with no
		// `street_centroid` table this lookup is a no-op miss, not a crash (mirrors the address-point reader).
		if (hasTable(this.#db, "street_centroid")) {
			this.#byPostcode = this.#db.prepare(
				`SELECT ${AGG_SELECT} FROM street_centroid WHERE postcode = ? AND street_norm = ?`
			)
			this.#byLocality = this.#db.prepare(
				`SELECT ${AGG_SELECT} FROM street_centroid WHERE locality_base = ? AND street_norm = ?`
			)
		}
	}

	find(query: { street: string; postcode?: string; locality?: string }): StreetCentroidHit | null {
		if (!this.#byPostcode || !this.#byLocality) return null
		const streetNorm = normalizeStreetForKeyLocale(query.street, this.#locale)

		if (!streetNorm) return null

		let row: AggRow | undefined

		if (query.postcode?.trim()) {
			row = this.#byPostcode.get(query.postcode.trim(), streetNorm) as AggRow | undefined
		}

		if ((!row || row.lat == null) && query.locality?.trim()) {
			const base = stripArrondissement(normalizeLocalityForKey(query.locality))
			row = this.#byLocality.get(base, streetNorm) as AggRow | undefined
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

	close(): void {
		this.#db.close()
	}
}
