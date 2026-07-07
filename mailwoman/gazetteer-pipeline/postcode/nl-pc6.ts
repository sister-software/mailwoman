/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build `postalcode-nl-pc6.db` — the NL full-postcode (PC6) shard, #977 tier 2. WOF NL carries NO
 *   `postalcode` tier at all, so `1012 LG` could only resolve to the Amsterdam locality centroid.
 *   Source: the CBS "Postcode6 statistieken" GeoPackage via PDOK (CC-BY 4.0 — provenance in `meta`),
 *   pre-extracted to a centroid CSV with ogr2ogr:
 *
 *     ogr2ogr -f CSV pc6-centroids.csv cbs_pc6_2024.gpkg -dialect sqlite \
 *       -sql "SELECT postcode6 AS pc6, ST_X(ST_Centroid(ST_Transform(geom, 4326))) AS lon,
 *             ST_Y(ST_Centroid(ST_Transform(geom, 4326))) AS lat FROM postcode6"
 *
 *   One `spr` row per PC6 (placetype `postalcode`, country NL, polygon centroid, degenerate bbox),
 *   the normalized form (`1012LG`) as `name` + the display form (`1012 LG`) as an extra `names` row —
 *   the same convention as `ingestGeonamesPostal`. The lookup's NL PC6 ladder (`lookup.ts` — full code
 *   → joined → 4-digit stem) was already built and is waiting on exactly this data. FTS + ANALYZE via
 *   the canonical `buildPlaceSearchFTS`. Readonly artifact: build to `.tmp`, swap into place
 *   (build-on-copy — the previous version moves aside, never mutated).
 *
 *   Run: node scripts/build-postalcode-nl-pc6.ts [--csv <pc6-centroids.csv>] [--out <postalcode-nl-pc6.db>]
 */

import { existsSync, readFileSync, renameSync, rmSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"

import { dataRootPath, sealDatabase } from "@mailwoman/core/utils"

/** Synthetic id base — distinct from the GeoNames postal range (9500000000000). */
const NL_PC6_ID_BASE = 9_600_000_000_000

export interface BuildNLPC6Options {
	/**
	 * CBS PC6 centroid CSV (see the ogr2ogr extraction in the module docstring). Default
	 * `<data-root>/cbs/pc6-centroids.csv`.
	 */
	csvPath?: string
	/** Output shard. Default `<data-root>/wof/postalcode-nl-pc6.db`. */
	out?: string
}

/**
 * Build the sealed NL PC6 shard (#977 tier 2). NOT re-exported from the postcode barrel — the command lazy-imports it
 * (optional-peer discipline).
 */
export async function buildNLPC6Shard(
	opts: BuildNLPC6Options = {}
): Promise<{ out: string; inserted: number; skipped: number }> {
	// resolver-wof-sqlite is an OPTIONAL peer — lazy import (the gazetteer-pipeline convention).
	const { buildPlaceSearchFTS } = await import("@mailwoman/resolver-wof-sqlite")
	const { normalizePostcodeName } = await import("@mailwoman/resolver-wof-sqlite/geonames-postal")
	const { createUnifiedIndexes, createUnifiedSchema } = await import("@mailwoman/resolver-wof-sqlite/unified-schema")
	const csvPath = opts.csvPath ?? String(dataRootPath("cbs", "pc6-centroids.csv"))
	const outPath = opts.out ?? String(dataRootPath("wof", "postalcode-nl-pc6.db"))
	const tmpPath = `${outPath}.tmp`

	const lines = readFileSync(csvPath, "utf8").trim().split("\n")
	const header = lines.shift()

	if (header !== "pc6,lon,lat") throw new Error(`unexpected CSV header: ${header}`)

	rmSync(tmpPath, { force: true })
	const db = new DatabaseSync(tmpPath)
	db.exec("PRAGMA journal_mode = OFF")
	db.exec("PRAGMA synchronous = OFF")
	await createUnifiedSchema(db)

	const sprInsert = db.prepare(
		`INSERT OR REPLACE INTO spr (id, parent_id, name, placetype, country, latitude, longitude, min_latitude, min_longitude, max_latitude, max_longitude, is_current, is_deprecated, is_ceased, is_superseded, is_superseding, lastmodified) VALUES (?, -1, ?, 'postalcode', 'NL', ?, ?, ?, ?, ?, ?, 1, 0, 0, 0, 0, 0)`
	)
	const namesInsert = db.prepare(
		`INSERT INTO names (id, name, placetype, country, language, lastmodified) VALUES (?, ?, 'postalcode', 'NL', '', 0)`
	)

	let inserted = 0
	let skipped = 0
	db.exec("BEGIN")

	for (const line of lines) {
		const [pc6Raw, lonS, latS] = line.split(",")
		const pc6 = (pc6Raw ?? "").trim().toUpperCase()
		const lon = Number(lonS)
		const lat = Number(latS)

		// A valid PC6 is 4 digits + 2 letters; the CBS file is already normalized (no space).
		if (!/^\d{4}[A-Z]{2}$/.test(pc6) || !Number.isFinite(lat) || !Number.isFinite(lon)) {
			skipped++
			continue
		}
		const name = normalizePostcodeName(pc6) // identity for the CBS form; keeps the convention explicit
		const display = `${pc6.slice(0, 4)} ${pc6.slice(4)}`
		const id = NL_PC6_ID_BASE + inserted

		sprInsert.run(id, name, lat, lon, lat, lon, lat, lon)
		namesInsert.run(id, name)

		if (display !== name) {
			namesInsert.run(id, display)
		}
		inserted++
	}
	db.exec("COMMIT")
	await createUnifiedIndexes(db)

	process.stderr.write(`spr rows: ${inserted} (skipped ${skipped}) — building place_search + place_bbox…\n`)
	buildPlaceSearchFTS(db, { drop: true })
	db.exec("ANALYZE")
	db.close()

	// Build-on-copy: the previous version moves aside; the new artifact swaps in atomically.
	if (existsSync(outPath)) {
		renameSync(outPath, `${outPath}.prev`)
	}
	renameSync(tmpPath, outPath)
	// The sealed-artifact invariant: a built DB is a read-only asset from the moment it exists.
	sealDatabase(outPath)

	return { out: outPath, inserted, skipped }
}
