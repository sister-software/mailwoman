/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   #474: build ES postcode centroids from the local Overture addresses parquet (ES postcode fill =
 *   100%, 15.7M points) and emit a `spr`-table SQLite DB the existing postcode-anchor harness consumes
 *   (`WofPostcodeLookup` / `postcode-anchor-accuracy.ts`). Per-postcode centroid = mean after dropping
 *   points >3σ from the per-postcode mean (agency data carries geocoding errors). Lets us measure
 *   Overture-derived centroids vs the shipped GeoNames-backfilled ones (postalcode-intl.db) on the
 *   ES eval rows — does Overture's 15.7M-point density beat GeoNames on anchor accuracy?
 *
 *   IT is OUT: Overture IT postcode fill = 0% (the #474 ingest gate "≥80% else renegotiate" fails) —
 *   GeoNames stays IT's source; documented as an Overture gap.
 *
 *   Run: node --experimental-strip-types scripts/eval/overture-es-postcode-centroids.ts
 *        [--parquet <path>] [--out <db>] [--country ES]
 */

import { DuckDBInstance } from "@duckdb/node-api"
import { DatabaseSync } from "node:sqlite"

const arg = (n: string, d: string): string => {
	const i = process.argv.indexOf(`--${n}`)
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : d
}
const CC = arg("country", "ES")
const PARQUET = arg("parquet", `/mnt/playpen/mailwoman-data/overture/2026-05-20.0/addresses-${CC.toLowerCase()}.parquet`)
const OUT_DB = arg("out", `/mnt/playpen/mailwoman-data/wof/postcode-${CC.toLowerCase()}-overture.db`)

const instance = await DuckDBInstance.create()
const conn = await instance.connect()

// Confirm the parquet columns first (the ingest output extracts ST_X/ST_Y → lat/lon).
const desc = await conn.runAndReadAll(`DESCRIBE SELECT * FROM read_parquet('${PARQUET}') LIMIT 1`)
console.error("columns:", desc.getRowObjects().map((r) => String(r["column_name"])).join(", "))

// Per-postcode centroid: mean of points within 3σ of the per-postcode mean (population stddev).
// ES postcodes are 5-digit; left-pad numeric codes so leading zeros survive (eval truth uses "01001").
const sql = `
WITH base AS (
  SELECT
    CASE WHEN regexp_full_match(trim(CAST(postcode AS VARCHAR)), '[0-9]{1,5}')
         THEN lpad(trim(CAST(postcode AS VARCHAR)), 5, '0')
         ELSE trim(CAST(postcode AS VARCHAR)) END AS pc,
    lat, lon
  FROM read_parquet('${PARQUET}')
  WHERE postcode IS NOT NULL AND trim(CAST(postcode AS VARCHAR)) != '' AND lat IS NOT NULL AND lon IS NOT NULL
),
stats AS (
  SELECT pc, avg(lat) ml, coalesce(stddev_pop(lat), 0) sl, avg(lon) mo, coalesce(stddev_pop(lon), 0) so
  FROM base GROUP BY pc
)
SELECT b.pc AS postcode, avg(b.lat) AS lat, avg(b.lon) AS lon, count(*) AS n
FROM base b JOIN stats s ON b.pc = s.pc
WHERE (s.sl = 0 OR abs(b.lat - s.ml) <= 3 * s.sl) AND (s.so = 0 OR abs(b.lon - s.mo) <= 3 * s.so)
GROUP BY b.pc
`
const res = await conn.runAndReadAll(sql)
const rows = res.getRowObjects() as Array<{ postcode: string; lat: number; lon: number; n: bigint }>
console.error(`extracted ${rows.length} ${CC} postcode centroids from Overture`)

// Emit the spr table the WofPostcodeLookup query consumes:
//   SELECT country, latitude, longitude FROM spr WHERE name=? AND placetype='postalcode' AND is_current!=0
const out = new DatabaseSync(OUT_DB)
out.exec(`
DROP TABLE IF EXISTS spr;
CREATE TABLE spr (
  id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL DEFAULT -1, name TEXT NOT NULL DEFAULT '',
  placetype TEXT NOT NULL DEFAULT '', country TEXT NOT NULL DEFAULT '',
  latitude REAL NOT NULL DEFAULT 0, longitude REAL NOT NULL DEFAULT 0,
  min_latitude REAL NOT NULL DEFAULT 0, min_longitude REAL NOT NULL DEFAULT 0,
  max_latitude REAL NOT NULL DEFAULT 0, max_longitude REAL NOT NULL DEFAULT 0,
  is_current INTEGER NOT NULL DEFAULT 1, is_deprecated INTEGER NOT NULL DEFAULT 0,
  is_ceased INTEGER NOT NULL DEFAULT 0, is_superseded INTEGER NOT NULL DEFAULT 0,
  is_superseding INTEGER NOT NULL DEFAULT 0, lastmodified INTEGER NOT NULL DEFAULT 0,
  source TEXT DEFAULT NULL, point_count INTEGER DEFAULT 0
);
`)
const ins = out.prepare(
	`INSERT INTO spr (id, name, placetype, country, latitude, longitude, is_current, source, point_count)
	 VALUES (?, ?, 'postalcode', ?, ?, ?, 1, 'overture:2026-05-20.0', ?)`
)
let id = 1
for (const r of rows) ins.run(id++, String(r.postcode), CC, Number(r.lat), Number(r.lon), Number(r.n))
out.exec(`CREATE INDEX spr_by_name ON spr(name); CREATE INDEX spr_by_country ON spr(country);`)
out.close()
console.error(`wrote ${rows.length} rows → ${OUT_DB}`)
