/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build the POSTAL-CITY ALIAS table (#475) from the pinned-release Overture US Parquet: per-address
 *   ground truth for the postal-city/geographic-city split that the resolver's coordinate-first
 *   soft-scorer currently approximates geometrically.
 *
 *   The signal: 45.9M US rows carry BOTH `postal_city` (what the postal system calls the place — USPS
 *   "acceptable city names", vanity cities) AND a geographic locality (`address_levels[2]`); 16.0M
 *   of them (34.9%) DIVERGE. Aggregated per `(postcode, postal_city, geo_locality)` with observed
 *   counts, that divergence is the alias evidence: "postcode 10954's mail says Nanuet; the polygon
 *   says Clarkstown".
 *
 *   SIBLING table by design (`postal_city_alias`, its own sqlite) — never mixed into the PIP-derived
 *   `postcode_locality` rows: one table = one provenance class (feedback-no-load-bearing-trivia). A
 *   count floor drops typo noise; everything kept is observed-in-the-wild N times, with N
 *   recorded.
 *
 *   Usage: node --experimental-strip-types scripts/build-postal-city-alias.ts\
 *   [--release 2026-05-20.0] [--min-count 25]\
 *   [--out /mnt/playpen/mailwoman-data/wof/postal-city-alias-us.db]
 */

import { mkdirSync, rmSync } from "node:fs"
import * as path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { parseArgs } from "node:util"

import { DuckDBInstance } from "@duckdb/node-api"
import { DatabaseClient } from "@mailwoman/core/kysley/client"
import {
	createPostalCityAliasTable,
	type PostalCityAliasDatabase,
} from "../resolver-wof-sqlite/postal-city-alias-schema.ts"

const { values: args } = parseArgs({
	options: {
		release: { type: "string", default: "2026-05-20.0" },
		"min-count": { type: "string", default: "25" },
		out: { type: "string", default: "/mnt/playpen/mailwoman-data/wof/postal-city-alias-us.db" },
	},
})
const PARQUET = `/mnt/playpen/mailwoman-data/overture/${args.release}/addresses-us.parquet`
const MIN_COUNT = Number(args["min-count"])

mkdirSync(path.dirname(args.out!), { recursive: true })
rmSync(args.out!, { force: true })

const instance = await DuckDBInstance.create()
const duck = await instance.connect()
const result = await duck.runAndReadAll(`
	SELECT
		trim(postcode) AS postcode,
		lower(trim(postal_city)) AS postal_city,
		lower(trim(address_levels[2].value)) AS geo_locality,
		count(*)::BIGINT AS n
	FROM read_parquet('${PARQUET}')
	WHERE nullif(trim(postcode), '') IS NOT NULL
		AND nullif(trim(postal_city), '') IS NOT NULL
		AND nullif(trim(address_levels[2].value), '') IS NOT NULL
	GROUP BY 1, 2, 3
	HAVING count(*) >= ${MIN_COUNT}
`)
const rows = result.getRowObjects() as { postcode: string; postal_city: string; geo_locality: string; n: bigint }[]

const db = new DatabaseSync(args.out!)
db.exec("PRAGMA journal_mode = WAL;")
// DDL via the SHARED createPostalCityAliasTable builder — the exact table the reader + tests use, so
// this producer can't drift from postal-city-alias-schema.ts. DuckDB above is the raw parquet reader;
// the hot INSERT below stays on the raw `db` handle.
const kdb = new DatabaseClient<PostalCityAliasDatabase>({ database: db })
await createPostalCityAliasTable(kdb)
const insert = db.prepare(
	"INSERT INTO postal_city_alias (postcode, postal_city, geo_locality, n, divergent, source, release) VALUES (?, ?, ?, ?, ?, ?, ?)"
)
db.exec("BEGIN")
let divergent = 0
for (const r of rows) {
	const isDivergent = r.postal_city !== r.geo_locality ? 1 : 0
	divergent += isDivergent
	insert.run(r.postcode, r.postal_city, r.geo_locality, Number(r.n), isDivergent, "overture:US", String(args.release))
}
db.exec("COMMIT")
// Indexes were created by createPostalCityAliasTable above; just checkpoint + compact.
db.exec("PRAGMA wal_checkpoint(TRUNCATE); VACUUM;")
await kdb.destroy()
console.log(`${rows.length} (postcode, postal_city, geo_locality) pairs (n >= ${MIN_COUNT}) → ${args.out}`)
console.log(`divergent pairs: ${divergent} (${((100 * divergent) / Math.max(1, rows.length)).toFixed(1)}%)`)
