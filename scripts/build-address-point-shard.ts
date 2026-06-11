/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build a per-state ADDRESS-POINT shard (#476) from the pinned-release Overture Parquet: exact
 *   `(street, number)` within a `(postcode | locality)` scope → exact point. The geocoder's
 *   street-level opening move — when the point exists you look it up; you interpolate (#483) only
 *   on miss. This shard is also the gold standard the future TIGER interpolation is graded
 *   against.
 *
 *   Keying uses THE shared normalizer (`resolver-wof-sqlite/street-normalize.ts`) — the same function
 *   the lookup tier applies at query time. Provenance per row (epic #470 rules): source dataset +
 *   release pinned in-table.
 *
 *   Usage: node --experimental-strip-types scripts/build-address-point-shard.ts\
 *   --state VT [--release 2026-05-20.0]\
 *   [--out /mnt/playpen/mailwoman-data/address-points/address-points-us-vt.db]\
 *   [--county-fips 17031 --county-boundary /tmp/tiger-county/tl_2023_us_county.shp]
 *
 *   County scoping (#483 density characterization): Overture carries no county field, so an optional
 *   `--county-fips` filter does a point-in-polygon against the TIGER COUNTY boundary shapefile
 *   (`--county-boundary`, same TIGER vintage as the EDGES the interpolation shard reads) — keeps a
 *   county-scoped gold comparable to a county-scoped segment table.
 */

import { mkdirSync, rmSync } from "node:fs"
import * as path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { parseArgs } from "node:util"

import { DuckDBInstance } from "@duckdb/node-api"

// Cross-tree source import (.ts explicit): this script runs via --experimental-strip-types,
// not from compiled out/ — the lookup tier imports the same module intra-package.
import {
	canonicalizeRouteKey,
	normalizeLocalityForKey,
	normalizeStreetForKey,
} from "../resolver-wof-sqlite/street-normalize.ts"

const { values: args } = parseArgs({
	options: {
		state: { type: "string" },
		release: { type: "string", default: "2026-05-20.0" },
		out: { type: "string" },
		"county-fips": { type: "string" },
		"county-boundary": { type: "string", default: "/tmp/tiger-county/tl_2023_us_county.shp" },
	},
})
if (!args.state) {
	console.error("--state required (US state abbreviation, e.g. VT)")
	process.exit(1)
}
if (args["county-fips"] && !/^\d{5}$/.test(args["county-fips"])) {
	console.error("--county-fips must be a 5-digit state+county FIPS (e.g. 17031)")
	process.exit(1)
}
const STATE = args.state.toUpperCase()
const PARQUET = `/mnt/playpen/mailwoman-data/overture/${args.release}/addresses-us.parquet`
const OUT = args.out ?? `/mnt/playpen/mailwoman-data/address-points/address-points-us-${STATE.toLowerCase()}.db`

mkdirSync(path.dirname(OUT), { recursive: true })
rmSync(OUT, { force: true }) // idempotent rebuild — never append across releases

const instance = await DuckDBInstance.create()
const duck = await instance.connect()
// Optional county scope: PIP against the TIGER COUNTY polygon (GEOID = state+county FIPS).
// DuckDB hoists the scalar subquery to a constant, so the per-row cost is the containment test.
let countyFilter = ""
if (args["county-fips"]) {
	await duck.run("INSTALL spatial; LOAD spatial;")
	countyFilter = `AND ST_Contains(
			(SELECT geom FROM ST_Read('${args["county-boundary"]}') WHERE GEOID = '${args["county-fips"]}'),
			ST_Point(lon, lat))`
}
const result = await duck.runAndReadAll(`
	SELECT
		number, street, unit, postcode,
		coalesce(nullif(trim(address_levels[2].value), ''), nullif(trim(postal_city), '')) AS locality,
		sources[1].dataset AS dataset,
		lat, lon
	FROM read_parquet('${PARQUET}')
	WHERE address_levels[1].value = '${STATE}'
		AND nullif(trim(street), '') IS NOT NULL
		AND nullif(trim(number), '') IS NOT NULL
		${countyFilter}
`)
const rows = result.getRowObjects() as Record<string, unknown>[]
console.log(`${rows.length} ${STATE} rows from ${path.basename(PARQUET)}`)

const db = new DatabaseSync(OUT)
db.exec(`
	PRAGMA journal_mode = WAL;
	CREATE TABLE address_point (
		street_norm   TEXT NOT NULL,
		street_key    TEXT NOT NULL, -- canonicalizeRouteKey(street_norm): the route-fold key (#483 Method 2)
		number        TEXT NOT NULL,
		unit          TEXT,
		postcode      TEXT,
		locality_norm TEXT,
		street_raw    TEXT NOT NULL,
		lat           REAL NOT NULL,
		lon           REAL NOT NULL,
		source        TEXT NOT NULL,
		release       TEXT NOT NULL
	);
`)

const insert = db.prepare(
	`INSERT INTO address_point (street_norm, street_key, number, unit, postcode, locality_norm, street_raw, lat, lon, source, release)
	 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
)
db.exec("BEGIN")
let kept = 0
for (const r of rows) {
	const streetRaw = String(r.street)
	const streetNorm = normalizeStreetForKey(streetRaw)
	if (!streetNorm) continue
	const locality = r.locality ? normalizeLocalityForKey(String(r.locality)) : null
	insert.run(
		streetNorm,
		canonicalizeRouteKey(streetNorm),
		String(r.number).trim().toLowerCase(),
		r.unit ? String(r.unit).trim().toLowerCase() : null,
		r.postcode ? String(r.postcode).trim() : null,
		locality,
		streetRaw,
		Number(r.lat),
		Number(r.lon),
		`overture:${r.dataset}`,
		String(args.release)
	)
	kept++
}
db.exec("COMMIT")
db.exec(`
	CREATE INDEX idx_ap_postcode ON address_point (postcode, street_norm, number);
	CREATE INDEX idx_ap_locality ON address_point (locality_norm, street_norm, number);
	CREATE INDEX idx_ap_streetkey ON address_point (postcode, street_key);
	PRAGMA wal_checkpoint(TRUNCATE);
	VACUUM;
`)
const stats = db
	.prepare(
		"SELECT count(*) AS n, count(DISTINCT street_norm) AS streets, count(DISTINCT postcode) AS postcodes FROM address_point"
	)
	.get() as Record<string, number>
db.close()
console.log(`${kept} points → ${OUT}`)
console.log(`distinct streets: ${stats.streets} · postcodes: ${stats.postcodes}`)
