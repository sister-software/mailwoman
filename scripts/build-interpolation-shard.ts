/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build a per-state STREET-SEGMENT shard (#483) from TIGER EDGES: side-aware house-number ranges +
 *   segment polylines, keyed by THE shared street normalizer
 *   (`resolver-wof-sqlite/street-normalize.ts` — same function the interpolation lookup applies at
 *   query time; one normalizer, never two). The interpolation tier's data half; design in
 *   `docs/articles/plan/2026-06-11-interpolation-design.md`.
 *
 *   One row PER SIDE per address-carrying road edge (left and right carry independent ranges and ZIPs
 *   in TIGER). Parity is derived from the from/to numbers ('odd' | 'even' | 'mixed'); descending
 *   ranges keep their raw from/to (direction matters for the interpolation position) alongside
 *   min/max index columns. Non-numeric ranges (hyphenated, alphanumeric) are skipped and counted.
 *
 *   Inputs: TIGER EDGES shapefiles per county (the same files the intersection eval reads),
 *   downloaded to --edges-dir from:
 *   https://www2.census.gov/geo/tiger/TIGER2023/EDGES/tl_2023_<countyfips>_edges.zip
 *
 *   Usage: node --experimental-strip-types scripts/build-interpolation-shard.ts\
 *   --state VT [--edges-dir /tmp/tiger-edges] [--release TIGER2023]\
 *   [--out /mnt/playpen/mailwoman-data/interpolation/interpolation-us-vt.db]
 */

import { globSync, mkdirSync, rmSync } from "node:fs"
import * as path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { parseArgs } from "node:util"

import { DuckDBInstance } from "@duckdb/node-api"

// Cross-tree source import (.ts explicit): this script runs via --experimental-strip-types,
// not from compiled out/ — the lookup tier imports the same module intra-package.
import { canonicalizeRouteKey, normalizeStreetForKey } from "../resolver-wof-sqlite/street-normalize.ts"

/** State abbreviation → state FIPS prefix, for picking county files out of --edges-dir. */
const STATE_FIPS: Record<string, string> = {
	VT: "50",
	IL: "17",
	NJ: "34",
}

const { values: args } = parseArgs({
	options: {
		state: { type: "string" },
		"edges-dir": { type: "string", default: "/tmp/tiger-edges" },
		release: { type: "string", default: "TIGER2023" },
		out: { type: "string" },
	},
})
if (!args.state || !STATE_FIPS[args.state.toUpperCase()]) {
	console.error(`--state required (one of: ${Object.keys(STATE_FIPS).join(", ")} — extend STATE_FIPS for others)`)
	process.exit(1)
}
const STATE = args.state.toUpperCase()
const OUT = args.out ?? `/mnt/playpen/mailwoman-data/interpolation/interpolation-us-${STATE.toLowerCase()}.db`

const shapefiles = globSync(`${args["edges-dir"]}/tl_*_${STATE_FIPS[STATE]}???_edges.shp`).sort()
if (shapefiles.length === 0) {
	console.error(`no tl_*_${STATE_FIPS[STATE]}???_edges.shp under ${args["edges-dir"]} — download TIGER EDGES first`)
	process.exit(1)
}
console.log(`${shapefiles.length} county shapefiles for ${STATE}`)

mkdirSync(path.dirname(OUT), { recursive: true })
rmSync(OUT, { force: true }) // idempotent rebuild — never append across releases

const db = new DatabaseSync(OUT)
db.exec(`
	PRAGMA journal_mode = WAL;
	CREATE TABLE street_segment (
		street_norm  TEXT NOT NULL,
		side         TEXT NOT NULL,
		from_hn      INTEGER NOT NULL,
		to_hn        INTEGER NOT NULL,
		min_hn       INTEGER NOT NULL,
		max_hn       INTEGER NOT NULL,
		parity       TEXT NOT NULL,
		postcode     TEXT,
		county_fips  TEXT NOT NULL,
		street_raw   TEXT NOT NULL,
		geometry     TEXT NOT NULL,
		source       TEXT NOT NULL,
		release      TEXT NOT NULL
	);
`)
const insert = db.prepare(
	`INSERT INTO street_segment
	 (street_norm, side, from_hn, to_hn, min_hn, max_hn, parity, postcode, county_fips, street_raw, geometry, source, release)
	 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
)

/** Strictly-numeric house number → integer, else null (hyphenated/alphanumeric skipped). */
function parseHn(raw: unknown): number | null {
	if (raw === null || raw === undefined) return null
	const s = String(raw).trim()
	if (!/^\d+$/.test(s)) return null
	return Number(s)
}

function parityOf(from: number, to: number): "odd" | "even" | "mixed" {
	const f = from % 2
	if (f !== to % 2) return "mixed"
	return f === 1 ? "odd" : "even"
}

const instance = await DuckDBInstance.create()
const duck = await instance.connect()
await duck.run("INSTALL spatial; LOAD spatial;")

let sides = 0
let skippedNonNumeric = 0
const parityCounts = { odd: 0, even: 0, mixed: 0 }

db.exec("BEGIN")
for (const shp of shapefiles) {
	const countyFips = path.basename(shp).match(/tl_\d+_(\d{5})_edges/)?.[1] ?? "unknown"
	// Address-carrying road edges only; geometry as GeoJSON text so the JS side stays
	// shapefile-free (same ST_Read approach as build-intersection-real.ts).
	const result = await duck.runAndReadAll(`
		SELECT FULLNAME AS name, LFROMADD, LTOADD, RFROMADD, RTOADD, ZIPL, ZIPR,
			ST_AsGeoJSON(geom) AS geojson
		FROM ST_Read('${shp}')
		WHERE MTFCC LIKE 'S1%' AND FULLNAME IS NOT NULL
			AND (LFROMADD IS NOT NULL OR RFROMADD IS NOT NULL)
	`)
	for (const r of result.getRowObjects() as Record<string, unknown>[]) {
		const streetRaw = String(r.name)
		const streetNorm = canonicalizeRouteKey(normalizeStreetForKey(streetRaw))
		if (!streetNorm) continue
		const geom = JSON.parse(String(r.geojson)) as { type: string; coordinates: number[][] }
		if (geom.type !== "LineString" || geom.coordinates.length < 2) continue
		// Round to 1e-6 deg (~0.1 m) — shapefile floats carry noise digits that bloat the JSON.
		const polyline = JSON.stringify(
			geom.coordinates.map(([lon, lat]) => [Math.round(lon! * 1e6) / 1e6, Math.round(lat! * 1e6) / 1e6])
		)

		for (const [side, fromRaw, toRaw, zip] of [
			["L", r.LFROMADD, r.LTOADD, r.ZIPL],
			["R", r.RFROMADD, r.RTOADD, r.ZIPR],
		] as const) {
			if (fromRaw === null && toRaw === null) continue
			const from = parseHn(fromRaw)
			const to = parseHn(toRaw)
			if (from === null || to === null) {
				skippedNonNumeric++
				continue
			}
			const parity = parityOf(from, to)
			parityCounts[parity]++
			insert.run(
				streetNorm,
				side,
				from,
				to,
				Math.min(from, to),
				Math.max(from, to),
				parity,
				zip === null || zip === undefined ? null : String(zip),
				countyFips,
				streetRaw,
				polyline,
				"tiger:edges",
				String(args.release)
			)
			sides++
		}
	}
	console.log(`  ${countyFips}: done (${sides} sides so far)`)
}
db.exec("COMMIT")
db.exec(`
	CREATE INDEX idx_seg_postcode ON street_segment (postcode, street_norm, min_hn);
	CREATE INDEX idx_seg_street   ON street_segment (street_norm, min_hn);
	PRAGMA wal_checkpoint(TRUNCATE);
	VACUUM;
`)
const stats = db
	.prepare(
		"SELECT count(*) AS n, count(DISTINCT street_norm) AS streets, count(DISTINCT postcode) AS postcodes FROM street_segment"
	)
	.get() as Record<string, number>
db.close()

console.log(`${sides} segment-sides → ${OUT}`)
console.log(`distinct streets: ${stats.streets} · postcodes: ${stats.postcodes}`)
console.log(`parity: odd ${parityCounts.odd} · even ${parityCounts.even} · mixed ${parityCounts.mixed}`)
console.log(`skipped non-numeric ranges: ${skippedNonNumeric}`)
