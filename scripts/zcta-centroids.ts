/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Census ZCTA centroid fill + GeoNames postal fill for placeholder US postcodes (#525).
 *
 *   WOF ships `(0,0)` for ~22% of US postcode records; every downstream artifact (pilot anchor
 *   lookup, `postcode-us.bin`, the slim hot DB's postcode cascade leg) inherits the holes. Two
 *   passes fill what they can:
 *
 *   1. **Census ZCTA Gazetteer** (public domain, ~33k ZCTAs, real internal-point centroids). Fills most
 *        standard delivery ZIPs. ZCTA != ZIP — PO-box-only and single-building ZIPs have no ZCTA
 *        and stay placeholder after this pass.
 *   2. **GeoNames postal** (CC-BY 4.0, `US.txt` from download.geonames.org/export/zip/US.zip). Covers
 *        some PO-box and unique ZIPs that appear in GeoNames but have no ZCTA. Multiple GeoNames
 *        rows for the same postcode are averaged into a single centroid. Source tag: `geonames-us`.
 *        License requires attribution in any DB that ships these coordinates.
 *
 *   Both passes record per-row provenance in a `centroid_source` table (`id` → `source`) and NEVER
 *   overwrite a real coordinate. Both are idempotent (the UPDATE re-checks `latitude=0`).
 *
 *   Data file notes: `/mnt/playpen/mailwoman-data/census/README.md` (ZCTA);
 *   download.geonames.org/export/zip/US.zip (GeoNames; CC-BY 4.0, attribute "GeoNames (CC-BY
 *   4.0)").
 *
 *   This module owns the parse + fill logic; `scripts/fill-zcta-centroids.ts` is the CLI and
 *   `scripts/build-pilot-anchor-lookup.py` mirrors the same join for lookup-build-time fills.
 *   Tested by `scripts/zcta-centroids.test.ts`.
 */

import type { DatabaseSync } from "node:sqlite"

/** Provenance label for rows filled from the 2024 ZCTA Gazetteer file. */
export const ZCTA_SOURCE = "census-zcta-2024"

/**
 * Provenance label for rows filled from the GeoNames US postal file (CC-BY 4.0). Any DB that ships
 * rows with this source tag must attribute "GeoNames (CC-BY 4.0)".
 */
export const GEONAMES_US_SOURCE = "geonames-us"

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
	// Raw DDL by design: this is a sync helper that borrows `db` and is exercised by a sync, heavily-
	// asserted test, so routing one IF-NOT-EXISTS provenance table through async Kysely isn't worth it.
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
 * Parse a GeoNames postal file (TSV, no header; columns: country(0), postcode(1), place(2),
 * adm1-name(3), adm1-code(4), adm2-name(5), adm2-code(6), adm3-name(7), adm3-code(8), lat(9),
 * lon(10), accuracy(11)) into a postcode → mean-centroid map. Multiple rows for the same postcode
 * (one per place sharing the code) are averaged. Non-finite coordinates and `(0,0)` placeholder
 * rows are skipped.
 *
 * Source: download.geonames.org/export/zip/<CC>.zip → `<CC>.txt`. License: CC-BY 4.0. Attribution
 * required in any DB that ships the resulting coordinates.
 */
export function parseGeonamesCentroids(text: string): Map<string, ZctaCentroid> {
	const acc = new Map<string, { lat: number; lon: number; n: number }>()
	for (const line of text.split("\n")) {
		if (!line.trim()) continue
		const f = line.split("\t")
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

	const out = new Map<string, ZctaCentroid>()
	for (const [pc, s] of acc) {
		out.set(pc, { lat: s.lat / s.n, lon: s.lon / s.n })
	}
	return out
}

/**
 * Fill `(0,0)`-placeholder US postcode rows from GeoNames postal centroids, stamping provenance as
 * `geonames-us`. Runs ONLY on rows that are still `(0,0)` — never overwrites a census-ZCTA or WOF
 * coordinate. Idempotent (the UPDATE re-checks `latitude=0 AND longitude=0`). Returns the number of
 * rows filled.
 *
 * GeoNames is CC-BY 4.0: any DB that ships rows with source `geonames-us` must attribute "GeoNames
 * (CC-BY 4.0)".
 */
export function fillGeonamesPlaceholders(
	db: DatabaseSync,
	geonames: ReadonlyMap<string, ZctaCentroid>,
	source: string = GEONAMES_US_SOURCE
): number {
	// Raw DDL by design: this is a sync helper that borrows `db` and is exercised by a sync, heavily-
	// asserted test, so routing one IF-NOT-EXISTS provenance table through async Kysely isn't worth it.
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
