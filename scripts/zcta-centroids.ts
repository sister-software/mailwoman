/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Census ZCTA centroid fill for placeholder US postcodes (#525).
 *
 *   WOF ships `(0,0)` for ~22% of US postcode records; every downstream artifact (pilot anchor
 *   lookup, `postcode-us.bin`, the slim hot DB's postcode cascade leg) inherits the holes. The US
 *   Census **ZCTA Gazetteer file** (public domain, ~33k ZCTAs, real internal-point centroids) fills
 *   most of them. ZCTA != ZIP — PO-box-only and single-building ZIPs have no ZCTA and stay
 *   placeholder — but a ZCTA centroid beats `(0,0)` by definition for the anchor/map-circle use.
 *
 *   Provenance (the no-load-bearing-trivia rule): a fill NEVER overwrites a real coordinate, and
 *   every filled row is recorded in a `centroid_source` table (`id` → `source`, e.g.
 *   `census-zcta-2024`) so attribution survives into the artifacts built from the DB. Data file +
 *   vintage notes: `/mnt/playpen/mailwoman-data/census/README.md`.
 *
 *   This module owns the parse + fill logic; `scripts/fill-zcta-centroids.ts` is the CLI and
 *   `scripts/build-pilot-anchor-lookup.py` mirrors the same join for lookup-build-time fills.
 *   Tested by `scripts/zcta-centroids.test.ts`.
 */

import type { DatabaseSync } from "node:sqlite"

/** Provenance label for rows filled from the 2024 ZCTA Gazetteer file. */
export const ZCTA_SOURCE = "census-zcta-2024"

export interface ZctaCentroid {
	lat: number
	lon: number
}

/**
 * Parse a Census ZCTA Gazetteer file (tab-delimited; header `GEOID ... INTPTLAT INTPTLONG`) into a
 * 5-digit-code → centroid map. Skips the header, non-5-digit GEOIDs, non-finite coordinates, and
 * `(0,0)` rows (a placeholder must never fill a placeholder).
 */
export function parseZctaCentroids(text: string): Map<string, ZctaCentroid> {
	const out = new Map<string, ZctaCentroid>()
	for (const line of text.split("\n")) {
		const fields = line.split("\t").map((f) => f.trim())
		const geoid = fields[0]
		if (!geoid || !/^\d{5}$/.test(geoid) || fields.length < 7) continue
		const lat = Number(fields[5])
		const lon = Number(fields[6])
		if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) continue
		out.set(geoid, { lat, lon })
	}
	return out
}

/**
 * Fill `(0,0)`-placeholder US postcode rows in a WOF postcode shard's `spr` table from the ZCTA
 * centroid map, recording per-row provenance in `centroid_source`. Rows with a real coordinate are
 * never touched; placeholders without a ZCTA stay placeholder (and get no provenance row).
 * Idempotent. Returns the number of rows filled.
 */
export function fillPlaceholderCentroids(
	db: DatabaseSync,
	zcta: ReadonlyMap<string, ZctaCentroid>,
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
