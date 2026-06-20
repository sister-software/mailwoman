/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build held-out coordinate eval sets for EU locales from the Overture Maps Addresses theme — the
 *   `{ input, lat, lon, expected:{locality,postcode}, state, source }` JSONL that
 *   oa-resolver-eval.ts and eu-coord-direct.ts consume. Each row is a native-format address string
 *   plus its rooftop lat/lon truth, sampled (reservoir, fixed seed → reproducible) from a
 *   per-country addresses parquet (produced by ingest-overture-addresses.ts).
 *
 *   The input string follows the European `{street} {number}, {postcode} {locality}` convention the
 *   first six zero-DB-locale sets used, so all 15 are graded apples-to-apples. `locality` flattens
 *   the deepest `address_levels` value with a `postal_city` fallback — the same rule the corpus
 *   adapter uses. Heavy native DuckDB lives in scripts/ only (never @mailwoman/corpus).
 *
 *   Usage: node --experimental-strip-types scripts/eval/build-eu-eval-set.ts\
 *   --countries BE,AT,CH,DK,SK,SI,LU,LV,LT --release 2026-06-17.0 --limit 1200 --out-dir /tmp/reg
 */
import { DuckDBInstance } from "@duckdb/node-api"
import { mkdirSync } from "node:fs"
import { parseArgs } from "node:util"

const { values: a } = parseArgs({
	options: {
		countries: { type: "string" },
		release: { type: "string", default: "2026-06-17.0" },
		"overture-dir": { type: "string", default: "/mnt/playpen/mailwoman-data/overture" },
		"out-dir": { type: "string", default: "/tmp/reg" },
		limit: { type: "string", default: "1200" },
		seed: { type: "string", default: "100" },
	},
})
if (!a.countries) {
	console.error("--countries is required (e.g. BE,AT,CH,DK)")
	process.exit(1)
}
const countries = a.countries.split(",").map((c) => c.trim().toUpperCase())
const limit = Number.parseInt(a.limit!, 10)
mkdirSync(a["out-dir"]!, { recursive: true })

const instance = await DuckDBInstance.create()
const con = await instance.connect()
await con.run("SET memory_limit='4GB'; SET threads=4;")

for (const cc of countries) {
	const parquet = `${a["overture-dir"]}/${a.release}/addresses-${cc.toLowerCase()}.parquet`
	const out = `${a["out-dir"]}/eu-eval-${cc.toLowerCase()}.jsonl`
	// `loc` = deepest address_levels value, postal_city fallback (the corpus adapter's rule).
	// Native EU order: "{street} {number}, {postcode} {locality}". Reservoir sample w/ fixed seed.
	const sql = `
		COPY (
			WITH src AS (
				SELECT street, number, postcode, lat, lon,
					COALESCE(NULLIF(trim(postal_city), ''), address_levels[len(address_levels)].value) AS loc
				FROM read_parquet('${parquet}')
				WHERE street IS NOT NULL AND trim(street) <> '' AND lat IS NOT NULL AND lon IS NOT NULL
			)
			SELECT
				trim(street)
					|| (CASE WHEN number IS NOT NULL AND trim(number) <> '' THEN ' ' || trim(number) ELSE '' END)
					|| ', '
					|| (CASE WHEN postcode IS NOT NULL AND trim(postcode) <> '' THEN trim(postcode) || ' ' ELSE '' END)
					|| loc AS input,
				lat, lon,
				{ 'locality': loc, 'postcode': COALESCE(trim(postcode), '') } AS expected,
				'' AS state,
				'overture:${cc.toLowerCase()}' AS source
			FROM src
			WHERE loc IS NOT NULL AND trim(loc) <> ''
			USING SAMPLE ${limit} ROWS (reservoir, ${a.seed})
		) TO '${out}' (FORMAT JSON)
	`
	try {
		await con.run(sql)
		const n = await con.runAndReadAll(`SELECT count(*) AS n FROM read_json_auto('${out}')`)
		console.log(`${cc}: ${(n.getRowObjects()[0] as { n: bigint }).n} rows -> ${out}`)
	} catch (e) {
		console.error(`${cc}: FAILED — ${(e as Error).message}`)
	}
}
con.closeSync()
