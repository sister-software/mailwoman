/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Builds per-postcode centroids from an Overture addresses parquet into a WOF-shaped `spr` database that
 *   `WOFPostcodeLookup` can query.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { OVERTURE_ADDRESSES_RELEASE } from "@mailwoman/core/overture-pins"
import { wofDatabasePath } from "@mailwoman/resolver-wof-sqlite/paths"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { PathBuilder } from "path-ts"

/**
 * Options for {@linkcode buildESPostcodeCentroids}.
 */
export interface ESPostcodeCentroidsOptions {
	/**
	 * ISO country code that selects the input parquet and the output name.
	 * It defaults to `ES`.
	 */
	country?: string
	/**
	 * Width to which numeric postcodes are left-padded with zeros, such as 5 for ES,
	 * DE, FR, IT and NL, or 4 for AT, CH and DK.
	 *
	 * The value `0` keeps the raw Overture form, which non-numeric formats need.
	 * It defaults to 5.
	 */
	pcLen?: number
	/**
	 * Input parquet path.
	 *
	 * It defaults to the pinned `OVERTURE_ADDRESSES_RELEASE` under `$MAILWOMAN_DATA_ROOT`.
	 */
	parquet?: string
	/**
	 * Output database path.
	 *
	 * It defaults to `$MAILWOMAN_DATA_ROOT/db/wof/postalcode-<cc>-overture.db`.
	 *
	 * The filename must start with `postalcode-`.
	 * `deriveSchemaName` turns the filename into the attached schema name, and `pickExtractsForPlacetype`
	 * routes queries by matching that name against the `postalcode` placetype.
	 */
	out?: string
}

/**
 * Builds the per-postcode centroid `spr` database from an Overture addresses parquet.
 */
export async function buildESPostcodeCentroids(options: ESPostcodeCentroidsOptions = {}): Promise<void> {
	const CC = options.country || "ES"
	const PC_LEN = options.pcLen ?? 5

	const PARQUET = PathBuilder.from(
		options.parquet || dataRootPath("overture", OVERTURE_ADDRESSES_RELEASE, `addresses-${CC.toLowerCase()}.parquet`)
	)

	const OUT_DB = options.out || wofDatabasePath(`postalcode-${CC.toLowerCase()}-overture.db`)
	// The release comes from the parquet path so that each row's `source` matches the input actually read.
	const RELEASE = /\d{4}-\d{2}-\d{2}\.\d+/u.exec(PARQUET.toString())?.[0] ?? "unknown"

	// `@duckdb/node-api` is an optional peer dependency, so it loads only when this command runs.
	const { DuckDBInstance } = await import("@duckdb/node-api")
	const instance = await DuckDBInstance.create()
	const conn = await instance.connect()

	// The query below expects `lat` and `lon` columns, which the ingest derives from the geometry.
	const desc = await conn.runAndReadAll(`DESCRIBE SELECT * FROM read_parquet('${PARQUET}') LIMIT 1`)

	console.error(
		"columns:",
		desc
			.getRowObjects()
			.map((r) => String(r["column_name"]))
			.join(", ")
	)

	// Each centroid is the mean of the points within three population standard deviations
	// of the postcode's mean, tested separately on latitude and longitude.
	// The padding restores leading zeros such as the one in "01001".
	const pcExpr =
		PC_LEN > 0
			? `CASE WHEN regexp_full_match(trim(CAST(postcode AS VARCHAR)), '[0-9]{1,${PC_LEN}}') THEN lpad(trim(CAST(postcode AS VARCHAR)), ${PC_LEN}, '0') ELSE trim(CAST(postcode AS VARCHAR)) END`
			: `trim(CAST(postcode AS VARCHAR))`

	const sql = `
WITH base AS (
  SELECT
    ${pcExpr} AS pc,
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

	// `WOFPostcodeLookup` reads `country`, `latitude` and `longitude` by `name`,
	// with `placetype = 'postalcode'` and `is_current != 0`.
	using out = new DatabaseClient<WOFDatabase>(OUT_DB)
	// The output is a rebuildable artifact, so journaling is off.
	// One transaction around all inserts keeps large countries fast, because a
	// transaction per row is slow enough to hit command timeouts.
	out.exec(`PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF;`)

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
		 VALUES (?, ?, 'postalcode', ?, ?, ?, 1, ?, ?)`
	)

	let id = 1
	out.exec("BEGIN")

	for (const r of rows) {
		ins.run(id++, String(r.postcode), CC, Number(r.lat), Number(r.lon), `overture:${RELEASE}`, Number(r.n))
	}

	out.exec("COMMIT")
	out.exec(`CREATE INDEX spr_by_name ON spr(name); CREATE INDEX spr_by_country ON spr(country);`)

	console.error(`wrote ${rows.length} rows → ${OUT_DB}`)
}
