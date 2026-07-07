/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build the confidence-calibration set for task #59 — a 50/50 blend of OpenAddresses (real,
 *   held-out) and training-corpus (in-domain, full-tag gold) addresses. The output is a flat JSONL
 *   the TS collector (`collect-span-confidences.ts`) runs the model over to pair each predicted
 *   span's raw softmax confidence with a correct/incorrect label.
 *
 *   Why 50/50 OA + corpus (the split the task names):
 *
 *   - OA gives REAL, genuinely-held-out addresses (the model never trained on them) but only PARTIAL
 *       gold — OpenAddresses carries {locality, region, postcode}, nothing else. So OA rows can
 *       only grade those three tags. This is the honest, un-gamed half.
 *   - Corpus gives FULL-tag gold (all 33 stage-3 BIO labels, incl. street decomposition / po_box /
 *       intersection) reconstructed from the tokens+labels, so the calibrator covers tags OA can't
 *       see. Caveat: the model trained on this corpus, so corpus rows are mildly OPTIMISTIC. The
 *       fitter reports an OA-only ECE alongside the combined number so that optimism is visible.
 *
 *   Each output row: {raw, gold: [[tag, value], ...], country, source, partial}
 *
 *   - `partial=true` (OA): grade ONLY tags present in `gold`; a predicted tag absent from gold is
 *       UNLABELABLE (skipped), not counted wrong.
 *   - `partial=false` (corpus): full gold; a predicted tag absent from gold IS wrong.
 *
 *   Corpus rows are filtered to >=2 distinct component tags so the corpus half reflects real
 *   multi-component addresses, not the bare "France" / "Paris" admin-name rows the wof-admin
 *   adapter emits in bulk.
 *
 *   Usage: node --experimental-strip-types scripts/eval/build-calibration-set.ts\
 *   --corpus
 *   /mnt/playpen/mailwoman-data/corpus/versioned/v0.4.0/corpus-v0.4.0/train/part-0000.parquet\
 *   --out data/eval/calibration/calibration-set.jsonl\
 *   [--oa-us 2000 --oa-fr 1000 --oa-de 500 --oa-nl 500 --corpus-n 4000 --seed 20260607]
 *
 *   Ported faithfully from scripts/eval/build-calibration-set.py. Parquet reads go through DuckDB
 *   (`@duckdb/node-api`). NOTE: the seeded RNG is distribution-faithful but NOT
 *   CPython-bit-identical (see python-random.ts); logic/filters/schema are preserved.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"

import { DuckDBInstance } from "@duckdb/node-api"

import { pyJsonDumps, pyReprDict } from "../lib/python-json.ts"
import { SeededRandom } from "../lib/python-random.ts"

const REPO = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const OA_DIR = join(REPO, "data", "eval", "external")
const OA_FILES: Record<string, string> = {
	US: "openaddresses-us-sample.jsonl",
	FR: "openaddresses-fr-sample.jsonl",
	DE: "openaddresses-de-sample.jsonl",
	NL: "openaddresses-nl-sample.jsonl",
}
// Only these three tags are present in OA gold (`expected`); grade nothing else for OA rows.
const OA_TAGS = ["locality", "region", "postcode"] as const

/** Coerce a DuckDB list column (a `DuckDBListValue` with `.items`, or a plain array) to `string[]`. */
function toStringArray(value: unknown): string[] {
	if (value == null) return []

	if (Array.isArray(value)) return value.map((v) => String(v))
	const items = (value as { items?: unknown[] }).items

	if (Array.isArray(items)) return items.map((v) => String(v))

	return []
}

function loadOa(country: string, n: number, rng: SeededRandom): Record<string, unknown>[] {
	const path = join(OA_DIR, OA_FILES[country]!)
	const rows = readFileSync(path, "utf-8")
		.split(/\r?\n/)
		.filter((line) => line.trim())
		.map((line) => JSON.parse(line) as Record<string, unknown>)
	rng.shuffle(rows)
	const out: Record<string, unknown>[] = []

	for (const r of rows.slice(0, n)) {
		const expected = (r.expected ?? {}) as Record<string, unknown>
		const gold: string[][] = []

		for (const t of OA_TAGS) {
			if (expected[t]) {
				gold.push([t, String(expected[t])])
			}
		}

		if (gold.length === 0) continue
		out.push({ raw: r.input, gold, country, source: "oa", partial: true })
	}

	return out
}

/** Group a BIO token/label stream into [tag, value] spans (value = space-joined tokens). */
function reconstructSpans(tokens: string[], labels: string[]): string[][] {
	const spans: string[][] = []
	let curTag: string | null = null
	let curToks: string[] = []
	const flush = (): void => {
		if (curTag && curToks.length) {
			spans.push([curTag, curToks.join(" ")])
		}
		curTag = null
		curToks = []
	}
	const n = Math.min(tokens.length, labels.length)

	for (let i = 0; i < n; i++) {
		const tok = tokens[i]!
		const lab = labels[i]!

		if (lab === "O" || !lab.includes("-")) {
			flush()
			continue
		}
		const dash = lab.indexOf("-")
		const prefix = lab.slice(0, dash)
		const tag = lab.slice(dash + 1)

		if (prefix === "B" || tag !== curTag) {
			flush()
			curTag = tag
			curToks = [tok]
		} else {
			// I- continuation of same tag
			curToks.push(tok)
		}
	}
	flush()

	return spans
}

async function loadCorpus(parquetPath: string, n: number, rng: SeededRandom): Promise<Record<string, unknown>[]> {
	const instance = await DuckDBInstance.create()
	const db = await instance.connect()
	const escaped = parquetPath.replace(/'/g, "''")
	const result = await db.runAndReadAll(`SELECT raw, tokens, labels, country FROM read_parquet('${escaped}')`)
	const table = result.getRowObjects() as Record<string, unknown>[]
	const total = table.length
	// Random row indices, then keep only multi-component addresses until we hit n.
	const order = Array.from({ length: total }, (_, i) => i)
	rng.shuffle(order)
	const out: Record<string, unknown>[] = []

	for (const idx of order) {
		if (out.length >= n) break
		const row = table[idx]!
		const gold = reconstructSpans(toStringArray(row.tokens), toStringArray(row.labels))
		const distinctTags = new Set(gold.map(([t]) => t))

		if (distinctTags.size < 2) continue // bare admin-name row — skip, see module docstring
		out.push({ raw: row.raw, gold, country: row.country, source: "corpus", partial: false })
	}

	return out
}

async function main(): Promise<void> {
	const { values } = parseArgs({
		options: {
			corpus: { type: "string" },
			out: { type: "string", default: join(REPO, "data/eval/calibration/calibration-set.jsonl") },
			"oa-us": { type: "string", default: "2000" },
			"oa-fr": { type: "string", default: "1000" },
			"oa-de": { type: "string", default: "500" },
			"oa-nl": { type: "string", default: "500" },
			"corpus-n": { type: "string", default: "4000" },
			seed: { type: "string", default: "20260607" },
		},
	})

	if (!values.corpus) {
		process.stderr.write("error: the following arguments are required: --corpus\n")
		process.exit(2)
	}

	const rng = new SeededRandom(Number(values.seed))
	const oa = [
		...loadOa("US", Number(values["oa-us"]), rng),
		...loadOa("FR", Number(values["oa-fr"]), rng),
		...loadOa("DE", Number(values["oa-de"]), rng),
		...loadOa("NL", Number(values["oa-nl"]), rng),
	]
	const corpus = await loadCorpus(values.corpus, Number(values["corpus-n"]), rng)
	const rows = [...oa, ...corpus]
	rng.shuffle(rows)

	const outPath = values.out!
	mkdirSync(dirname(outPath), { recursive: true })
	writeFileSync(outPath, rows.map((r) => pyJsonDumps(r, { ensureAscii: false }) + "\n").join(""))

	const byCountry = new Map<string, number>()

	for (const r of rows) {
		const c = String(r.country)
		byCountry.set(c, (byCountry.get(c) ?? 0) + 1)
	}
	console.log(`wrote ${rows.length} rows → ${outPath}`)
	console.log(`  OA=${oa.length}  corpus=${corpus.length}`)
	console.log(`  by country: ${pyReprDict([...byCountry.entries()].sort((a, b) => b[1] - a[1]))}`)
}

await main()
