/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Assemble a balanced (address → country) dataset for the #244 coarse-placer from the v0.5.0
 *   corpus. STRATIFIED: a flat random sample is 94% US+FR, so we sample up to N rows PER country
 *   and union.
 *
 *   Two gotchas this handles:
 *
 *   - DuckDB `USING SAMPLE n ROWS` samples the TABLE, then WHERE filters the sample — so we
 *       filter-THEN-sample in a subquery to get a true per-country sample.
 *   - The corpus val/test shards only carry US/FR/DE, so we draw ALL splits from the rich `train`
 *       shards and do our OWN per-country 80/10/10 split (dedup on raw → no row crosses splits).
 *
 *   Usage: node scripts/coarse-placer/build-dataset.mjs [--per-country 50000] Output:
 *   data/coarse-placer/{train,val,test}.jsonl (rows: {raw, country})
 */

import { mkdirSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { parseArgs } from "node:util"

import { DuckDBInstance } from "@duckdb/node-api"

const { values: args } = parseArgs({ options: { "per-country": { type: "string", default: "50000" } } })
const PER = Number(args["per-country"])
const VAL_FRAC = 0.1
const TEST_FRAC = 0.1

const COUNTRIES = ["US", "FR", "GB", "CN", "NL", "IT", "DE", "JP", "ES", "KR", "TW"]
const TRAIN_GLOB = "/mnt/playpen/mailwoman-data/corpus/versioned/v0.5.0/corpus-v0.5.0/train/*.parquet"
const OUT_DIR = path.resolve(import.meta.dirname, "../../data/coarse-placer")
mkdirSync(OUT_DIR, { recursive: true })

const duck = await (await DuckDBInstance.create()).connect()

const train = [],
	val = [],
	test = []
for (const country of COUNTRIES) {
	// filter-THEN-sample: the subquery restricts to the country, SAMPLE draws from that filtered set.
	const q = `SELECT raw FROM (
			SELECT raw FROM read_parquet('${TRAIN_GLOB}') WHERE country = '${country}' AND nullif(trim(raw), '') IS NOT NULL
		) USING SAMPLE ${Math.ceil(PER * 1.3)} ROWS`
	const res = await duck.runAndReadAll(q)
	const seen = new Set()
	const rows = []
	for (const r of res.getRowObjects()) {
		if (rows.length >= PER) break
		const raw = String(r.raw).trim()
		if (!raw || seen.has(raw)) continue
		seen.add(raw)
		rows.push(raw)
	}
	const nVal = Math.floor(rows.length * VAL_FRAC)
	const nTest = Math.floor(rows.length * TEST_FRAC)
	const valRows = rows.slice(0, nVal)
	const testRows = rows.slice(nVal, nVal + nTest)
	const trainRows = rows.slice(nVal + nTest)
	for (const raw of trainRows) train.push({ raw, country })
	for (const raw of valRows) val.push({ raw, country })
	for (const raw of testRows) test.push({ raw, country })
	console.log(`  ${country}: train ${trainRows.length}  val ${valRows.length}  test ${testRows.length}`)
}

for (const [name, rows] of [
	["train", train],
	["val", val],
	["test", test],
]) {
	rows.sort((a, b) => hash(a.raw + a.country) - hash(b.raw + b.country)) // deterministic class-interleave
	const p = path.join(OUT_DIR, `${name}.jsonl`)
	writeFileSync(p, rows.map((r) => JSON.stringify(r)).join("\n") + "\n")
	console.log(`→ ${p}  (${rows.length} rows)`)
}

function hash(s) {
	let h = 2166136261
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i)
		h = Math.imul(h, 16777619)
	}
	return h >>> 0
}
