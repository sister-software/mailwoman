/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { readUnquotedTSVText } from "@mailwoman/core/fs/delimited"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import type { LatLon } from "@mailwoman/spatial"
import type { DatabaseClient } from "@mailwoman/sqlite/client"

const GAZETTEER_ROW_COLUMNS = 7

/**
 * Provenance label for rows filled from the 2024 zcta Gazetteer file.
 */
export const ZCTA_SOURCE = "census-zcta-2024"

/**
 * Tags centroid rows filled from the GeoNames US postal file.
 *
 * That file uses CC-BY 4.0, so a database shipping these rows must attribute "GeoNames (CC-BY 4.0)".
 */
export const GEONAMES_US_SOURCE = "geonames-us"

/**
 * Parses a Census ZCTA Gazetteer TSV into a map from 5-digit code to its internal point,
 * skipping `(0,0)` rows so a placeholder never fills a placeholder.
 */
export function parseZCTACentroids(text: string): Map<string, LatLon> {
	const out = new Map<string, LatLon>()

	for (const row of readUnquotedTSVText(text)) {
		const fields = row
		const geoid = fields[0]

		if (!geoid || !/^\d{5}$/.test(geoid) || fields.length < GAZETTEER_ROW_COLUMNS) continue
		const lat = Number(fields[5])
		const lon = Number(fields[6])

		if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) continue
		out.set(geoid, { lat, lon })
	}

	return out
}

/**
 * Fills current US postcode rows in `spr` that still sit at `(0,0)` from the given
 * centroid map and records each filled row's provenance in `centroid_source`.
 *
 * Rows with a real coordinate are never touched, so the fill is idempotent.
 *
 * @returns The number of rows filled.
 */
export function fillPlaceholderCentroids(
	db: DatabaseClient<WOFDatabase>,
	zcta: ReadonlyMap<string, LatLon>,
	source: string = ZCTA_SOURCE
): number {
	db.exec(`CREATE TABLE IF NOT EXISTS centroid_source (id INTEGER PRIMARY KEY, source TEXT NOT NULL)`)

	const placeholders = db
		.prepare(
			`SELECT id, name FROM spr
			 WHERE placetype='postalcode' AND is_current!=0 AND country='US' AND latitude=0 AND longitude=0`
		)
		.all() as Array<{ id: number; name: string }>

	const update = db.prepare(
		`UPDATE spr SET latitude=?, longitude=?, min_latitude=?, max_latitude=?, min_longitude=?, max_longitude=?
		 WHERE id=? AND latitude=0 AND longitude=0`
	)

	const stamp = db.prepare(`INSERT OR REPLACE INTO centroid_source (id, source) VALUES (?, ?)`)

	let filled = 0
	db.exec("BEGIN")

	for (const row of placeholders) {
		const c = zcta.get(String(row.name).trim())

		if (!c) continue
		const res = update.run(c.lat, c.lon, c.lat, c.lat, c.lon, c.lon, row.id)

		if (Number(res.changes) > 0) {
			stamp.run(row.id, source)

			filled++
		}
	}

	db.exec("COMMIT")

	return filled
}

/**
 * Parses a headerless GeoNames postal TSV into a map from postcode to the mean
 * of its place coordinates, skipping `(0,0)` rows.
 *
 * It deliberately does not reuse `geonamesPostalRows`, whose different number
 * parsing would shift the stored mean centroids.
 */
export function parseGeonamesCentroids(text: string): Map<string, LatLon> {
	const acc = new Map<string, { lat: number; lon: number; n: number }>()

	for (const f of readUnquotedTSVText(text)) {
		const pc = f[1]?.trim()
		const lat = Number(f[9])
		const lon = Number(f[10])

		if (!pc || !Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) continue
		const cur = acc.get(pc)

		if (cur) {
			cur.lat += lat
			cur.lon += lon

			cur.n++
		} else {
			acc.set(pc, { lat, lon, n: 1 })
		}
	}

	const out = new Map<string, LatLon>()

	for (const [pc, s] of acc) {
		out.set(pc, { lat: s.lat / s.n, lon: s.lon / s.n })
	}

	return out
}

/**
 * Fill current US postcode rows in `spr` that remain `(0,0)` with GeoNames centroids.
 *
 * Census ZCTA and WOF coordinates stay intact.
 * Stamp each filled row as `geonames-us`.
 *
 * @returns The number of rows filled.
 */
export function fillGeonamesPlaceholders(
	db: DatabaseClient<WOFDatabase>,
	geonames: ReadonlyMap<string, LatLon>,
	source: string = GEONAMES_US_SOURCE
): number {
	db.exec(`CREATE TABLE IF NOT EXISTS centroid_source (id INTEGER PRIMARY KEY, source TEXT NOT NULL)`)

	const placeholders = db
		.prepare(
			`SELECT id, name FROM spr
			 WHERE placetype='postalcode' AND is_current!=0 AND country='US' AND latitude=0 AND longitude=0`
		)
		.all() as Array<{ id: number; name: string }>

	const update = db.prepare(
		`UPDATE spr SET latitude=?, longitude=?, min_latitude=?, max_latitude=?, min_longitude=?, max_longitude=?
		 WHERE id=? AND latitude=0 AND longitude=0`
	)

	const stamp = db.prepare(`INSERT OR REPLACE INTO centroid_source (id, source) VALUES (?, ?)`)

	let filled = 0
	db.exec("BEGIN")

	for (const row of placeholders) {
		const c = geonames.get(String(row.name).trim())

		if (!c) continue
		const res = update.run(c.lat, c.lon, c.lat, c.lat, c.lon, c.lon, row.id)

		if (Number(res.changes) > 0) {
			stamp.run(row.id, source)

			filled++
		}
	}

	db.exec("COMMIT")

	return filled
}
