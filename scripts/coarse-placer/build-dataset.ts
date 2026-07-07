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
 *   Usage: node scripts/coarse-placer/build-dataset.ts [--per-country 50000] Output:
 *   data/coarse-placer/{train,val,test}.jsonl (rows: {raw, country})
 */

import { mkdirSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { parseArgs } from "node:util"

import { DuckDBInstance } from "@duckdb/node-api"
import { dataRootPath } from "@mailwoman/core/utils"

interface DatasetRow {
	raw: string
	country: string
}

const { values: args } = parseArgs({ options: { "per-country": { type: "string", default: "50000" } } })
const PER = Number(args["per-country"])
const VAL_FRAC = 0.1
const TEST_FRAC = 0.1

const COUNTRIES = ["US", "FR", "GB", "CN", "NL", "IT", "DE", "JP", "ES", "KR", "TW"]
const TRAIN_GLOB = dataRootPath("corpus", "versioned", "v0.5.0", "corpus-v0.5.0", "train", "*.parquet")
// #244/#928 AU expansion: the v0.5.0 pin carries only ~5.9k AU rows; the v0.9.2 G-NAF shard carries
// 150k real Australian addresses. AU rides the SAME corpus sampling path as COUNTRIES, just from its
// own glob — the (country, glob) pairs below unify the two.
const AU_GLOB = dataRootPath(
	"corpus",
	"versioned",
	"v0.9.2-multilocale-au",
	"corpus-v0.9.2-multilocale-au",
	"train",
	"*.parquet"
)
const OUT_DIR = path.resolve(import.meta.dirname, "../../data/coarse-placer")

// #743: the EU expansion. The v0.5.0 corpus carries zero rows for these locales, so they're drawn
// from the Overture per-country addresses theme (the same source build-eu-eval-set.ts uses). They
// were previously OTHER outlier exposure (PL/PT/CZ) or simply unrepresentable; here they become
// first-class in-map countries so the soft country prior can pin them.
const NEW_EU = ["AT", "BE", "CH", "CZ", "DK", "EE", "FI", "HR", "LT", "LU", "LV", "NO", "PL", "PT", "SI", "SK"]
// #743 in-map dilution fix: DE/ES/IT/NL are already in COUNTRIES (corpus format), but the eu-eval
// sets + every NEW_EU country are Overture format. Without an Overture sample of their OWN, their
// Overture-format eval rows scatter to the Overture-trained neighbours (measured: only 63% of ES
// eval rows routed ES, ~26% leaked to CH/PT/HR/IT/FR/CZ). SUPPLEMENT their corpus rows with an
// Overture sample so each owns its own format shape; the format then stops being discriminative and
// the model falls back to the linguistic n-grams. GB excluded — its Overture parquet is empty.
const IN_MAP_EU = ["DE", "ES", "IT", "NL"]
const OVERTURE_DIR = dataRootPath("overture", "2026-06-17.0")
mkdirSync(OUT_DIR, { recursive: true })

const duck = await (await DuckDBInstance.create()).connect()
await duck.run("SET memory_limit='4GB'; SET threads=4;")

const train: DatasetRow[] = [],
	val: DatasetRow[] = [],
	test: DatasetRow[] = []

const CORPUS_SOURCES: ReadonlyArray<[string, string]> = [
	...COUNTRIES.map((c): [string, string] => [c, String(TRAIN_GLOB)]),
	["AU", String(AU_GLOB)],
]

for (const [country, glob] of CORPUS_SOURCES) {
	// filter-THEN-sample: the subquery restricts to the country, SAMPLE draws from that filtered set.
	const q = `SELECT raw FROM (
			SELECT raw FROM read_parquet('${glob}') WHERE country = '${country}' AND nullif(trim(raw), '') IS NOT NULL
		) USING SAMPLE ${Math.ceil(PER * 1.3)} ROWS`
	const res = await duck.runAndReadAll(q)
	const seen = new Set<string>()
	const rows: string[] = []

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

	for (const raw of trainRows) {
		train.push({ raw, country })
	}

	for (const raw of valRows) {
		val.push({ raw, country })
	}

	for (const raw of testRows) {
		test.push({ raw, country })
	}
	console.log(`  ${country}: train ${trainRows.length}  val ${valRows.length}  test ${testRows.length}`)
}

// #743 EU expansion: draw the new in-map countries from the Overture per-country addresses theme.
// The raw fields are formatted into native address strings with FORMAT VARIETY (4 templates picked
// deterministically per row) so the model can't shortcut on a single template shape — it must use
// the actual street-type words + locality n-grams (Finnish "katu/tie", Polish "ul.", Norwegian
// "veien") that carry the country signal. Same 80/10/10 dedup split as the corpus path.
function formatEu(street: unknown, number: unknown, postcode: unknown, loc: string, t: number): string {
	const s = String(street).trim()
	const num = number != null && String(number).trim() !== "" ? ` ${String(number).trim()}` : ""
	const pc = postcode != null && String(postcode).trim() !== "" ? String(postcode).trim() : ""

	switch (t) {
		case 1:
			return `${s}${num} ${loc}` // no postcode, no comma
		case 2:
			return `${s}${num}, ${loc}${pc ? `, ${pc}` : ""}` // postcode trailing
		case 3:
			return `${s}, ${pc ? `${pc} ` : ""}${loc}` // no house number
		default:
			return `${s}${num}, ${pc ? `${pc} ` : ""}${loc}` // {street number, postcode locality}
	}
}

for (const country of [...NEW_EU, ...IN_MAP_EU]) {
	const parquet = `${OVERTURE_DIR}/addresses-${country.toLowerCase()}.parquet`
	const q = `SELECT street, number, postcode,
			COALESCE(NULLIF(trim(postal_city), ''), address_levels[len(address_levels)].value) AS loc
		FROM read_parquet('${parquet}')
		WHERE street IS NOT NULL AND trim(street) <> ''
		USING SAMPLE ${Math.ceil(PER * 1.4)} ROWS`
	let res

	try {
		res = await duck.runAndReadAll(q)
	} catch (e) {
		console.error(`  ${country}: SKIPPED — ${(e as Error).message}`)
		continue
	}
	const seen = new Set<string>()
	const rows: string[] = []

	for (const r of res.getRowObjects()) {
		if (rows.length >= PER) break
		const loc = r.loc == null ? "" : String(r.loc).trim()

		if (!loc) continue
		const raw = formatEu(r.street, r.number, r.postcode, loc, hash(`${r.street}|${loc}`) % 4)

		if (!raw || seen.has(raw)) continue
		seen.add(raw)
		rows.push(raw)
	}
	const nVal = Math.floor(rows.length * VAL_FRAC)
	const nTest = Math.floor(rows.length * TEST_FRAC)

	for (const raw of rows.slice(0, nVal)) {
		val.push({ raw, country })
	}

	for (const raw of rows.slice(nVal, nVal + nTest)) {
		test.push({ raw, country })
	}

	for (const raw of rows.slice(nVal + nTest)) {
		train.push({ raw, country })
	}
	console.log(`  ${country} (overture): train ${rows.length - nVal - nTest}  val ${nVal}  test ${nTest}`)
}

const splits: [string, DatasetRow[]][] = [
	["train", train],
	["val", val],
	["test", test],
]

for (const [name, rows] of splits) {
	rows.sort((a, b) => hash(a.raw + a.country) - hash(b.raw + b.country)) // deterministic class-interleave
	const p = path.join(OUT_DIR, `${name}.jsonl`)
	writeFileSync(p, rows.map((r) => JSON.stringify(r)).join("\n") + "\n")
	console.log(`→ ${p}  (${rows.length} rows)`)
}

function hash(s: string): number {
	let h = 2166136261

	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i)
		h = Math.imul(h, 16777619)
	}

	return h >>> 0
}
