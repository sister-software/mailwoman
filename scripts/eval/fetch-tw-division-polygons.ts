/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Fetch TW admin polygons from the Overture `divisions` theme (#473 eval support).
 *
 *   The WOF admin-tw repo is POINT-ONLY (every main + `-alt-quattroshapes_pg` feature is a Point —
 *   verified 2026-07-02), so the TW postcode-route PIP-containment gate (#294, inherited by #473)
 *   can't be scored against WOF polygons. The Overture divisions theme carries real district
 *   polygons; this script materializes them locally, release-pinned, so the eval
 *   (`tw-postcode-route-eval.ts`) can point-in-polygon against them.
 *
 *   Level semantics for TW in the divisions theme (probed on 2026-06-17.0): `region` = the 22
 *   county-level units (直轄市/縣/市, 26 rows incl. island groups), `locality` = districts AND
 *   villages mixed. Districts are distinguished by name suffix 區/鄉/鎮/市 (367 + 釣魚臺列嶼);
 *   villages end 里/村 and are excluded here.
 *
 *   OOM discipline: threads + memory are capped (the box was OOM-killed once on a naive
 *   read_parquet over the addresses theme, 2026-06-19), and rows land on disk via `COPY` — nothing
 *   is materialized into JS memory.
 *
 *   Usage: node scripts/eval/fetch-tw-division-polygons.ts [--release 2026-06-17.0] [--out <dir>]
 */

import { mkdirSync } from "node:fs"
import * as path from "node:path"
import { parseArgs } from "node:util"

import { DuckDBInstance } from "@duckdb/node-api"
import { dataRootPath } from "@mailwoman/core/utils"

const DEFAULT_RELEASE = "2026-06-17.0"

const { values } = parseArgs({
	options: {
		release: { type: "string" },
		out: { type: "string" },
	},
})

const release = values.release ?? DEFAULT_RELEASE
const outDir = values.out ?? path.join(dataRootPath("overture"), release)
mkdirSync(outDir, { recursive: true })
const dest = path.join(outDir, "divisions-tw-admin.jsonl")

const glob = `s3://overturemaps-us-west-2/release/${release}/theme=divisions/type=division_area/*.parquet`

const instance = await DuckDBInstance.create()
const db = await instance.connect()

await db.run("INSTALL httpfs; LOAD httpfs;")
await db.run("INSTALL spatial; LOAD spatial;")
await db.run("SET s3_region='us-west-2';")
// Modest parallelism + a hard ceiling — see the header note on the 2026-06-19 OOM.
await db.run("SET threads=4;")
await db.run("SET memory_limit='8GB';")

const divisionGlob = `s3://overturemaps-us-west-2/release/${release}/theme=divisions/type=division/*.parquet`

const started = Date.now()
// The `division` rows carry the wikidata concordance the polygon rows lack; the join hands the
// eval + builder a principled WOF bridge (division.wikidata ↔ WOF concordances `wd:id`) for the
// districts whose WOF point sits outside its own polygon (e.g. Wanhua, ~5 km west).
await db.run(`
	COPY (
		SELECT
			a.id,
			a.division_id,
			a.subtype,
			a.names.primary AS name,
			d.names.common['en'] AS name_en,
			d.wikidata AS wikidata,
			ST_AsGeoJSON(a.geometry) AS geometry
		FROM read_parquet('${glob}', hive_partitioning = 1) a
		LEFT JOIN read_parquet('${divisionGlob}', hive_partitioning = 1) d
			ON d.id = a.division_id AND d.country = 'TW'
		WHERE a.country = 'TW'
			AND (
				a.subtype = 'region'
				OR (a.subtype = 'locality' AND right(a.names.primary, 1) IN ('區', '鄉', '鎮', '市', '嶼'))
			)
	) TO '${dest}' (FORMAT JSON)
`)

const rows = await db.runAndReadAll(`SELECT subtype, count(*)::BIGINT AS n FROM read_json('${dest}') GROUP BY 1`)

console.log(`divisions-tw-admin: ${dest} (${((Date.now() - started) / 1000).toFixed(0)}s)`)

for (const r of rows.getRowObjects() as Array<{ subtype: string; n: bigint }>) {
	console.log(`  ${r.subtype}: ${r.n}`)
}
db.closeSync()
