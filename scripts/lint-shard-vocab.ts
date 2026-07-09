/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   #511 base-consistency lint, GENERALIZED + COUNTRY-SCOPED (v2) — any synthetic shard vs the base.
 *
 *   Ported from scripts/lint-shard-vocab.py (pyarrow → @duckdb/node-api); behavior preserved
 *   byte-for-byte (same flags, same stdout, same exit codes). The base-root default routes through
 *   `dataRootPath` so the lab `/mnt/playpen` literal stays in its one home
 *   (core/utils/data-root.ts) and `$MAILWOMAN_DATA_ROOT` is honored; with the env unset it equals
 *   the Python default.
 *
 *   The #511 lesson: a synthetic shard must not label a token a tag the BASE dominantly labels
 *   something else, or training gets conflicting gradients on the same token and the minority (the
 *   shard) loses. This reads a shard's own (token -> tag) and checks each token against the base.
 *
 *   WHY v2 IS COUNTRY-SCOPED + FULL-COUNT (the night-2026-06-18 lesson, learned the hard way over
 *   three tries): a token's correct tag is COUNTRY-specific — "Paris" is locality in FR data and
 *   street in US "Paris Ave"; "Marion" is a US town AND many US "Marion" streets. So:
 *
 *   1. A cross-COUNTRY aggregate mis-judges any country-specific token (v1 uniform AND a proportional
 *        retry both false-flagged FR cities as "street" from US street-contexts).
 *   2. A SMALL sample is street-BIASED regardless, because the street sources (tiger 39 + nad 378 parts)
 *        dwarf the locality sources (a small US-scoped spot-check read Indianapolis 54% street vs
 *        its true 219700:29 LOCALITY). The fix: tally each shard token's base tag SCOPED to the
 *        country the shard uses it in (the base has a `country` column), over a LARGE/FULL scan
 *        (--fraction, default 1.0). Pure-numeric tokens excluded (house_number/postcode are
 *        context-determined). An affix-split flag (shard street_suffix/_prefix vs base "street") is
 *        EXPECTED — the loader's affix-relabel handles it; weigh those separately.
 *
 *   Usage: node scripts/lint-shard-vocab.ts --shard <shard.parquet>
 *   [--base-version v0.5.0] [--base-root <dir>] [--fraction 1.0] [--threshold 0.7] [--min-count
 *   50]
 */

import { readdirSync } from "node:fs"
import { join } from "node:path"
import { parseArgs } from "node:util"

import { DuckDBInstance } from "@duckdb/node-api"
import { dataRootPath } from "@mailwoman/core/utils"

/** A column-projected base/shard row: parallel token + label lists plus the row's country. */
interface CorpusRow {
	tokens: string[]
	labels: string[]
	country: string | null
}

/** Strip a BIO prefix ("B-"/"I-") off a label, matching the Python `strip_bio`. */
function stripBIO(label: string): string {
	const head = label.slice(0, 2)

	return head === "B-" || head === "I-" ? label.slice(2) : label
}

/**
 * Python `str.isdigit()`: non-empty and every character a Unicode digit. Pure-numeric tokens (house_number / postcode)
 * are context-determined, not lexical vocab, so they're excluded. `\p{Nd}` covers the decimal digits these address
 * corpora actually contain.
 */
function isDigit(token: string): boolean {
	return token.length > 0 && /^\p{Nd}+$/u.test(token)
}

/**
 * Round half to even (banker's rounding) — Python's built-in `round()` and `format(..., ".0%")` both use it, so percent
 * strings and the proportional `--fraction` slice match the Python output exactly.
 */
function pyRound(x: number): number {
	const floor = Math.floor(x)
	const diff = x - floor

	if (diff < 0.5) return floor

	if (diff > 0.5) return floor + 1

	return floor % 2 === 0 ? floor : floor + 1
}

/** Format a fraction as a whole-percent string the way Python's `:.0%` does, e.g. 0.73 -> "73%". */
function pct(frac: number): string {
	return `${pyRound(frac * 100)}%`
}

/**
 * Format a float the way a Python f-string renders it: integer-valued floats keep one decimal (1.0 -> "1.0"),
 * everything else is its shortest decimal (0.5 -> "0.5"). Used for the `--fraction` echo so the banner matches the
 * Python print.
 */
function pyFloat(n: number): string {
	return Number.isInteger(n) ? n.toFixed(1) : String(n)
}

/** Left-justify to a minimum width with spaces, matching Python's `{value:N}` string field. */
function pad(value: string, width: number): string {
	return value.padEnd(width)
}

/**
 * The dominant tag of a counter: (tag, total, fraction). Empty counter -> ("", 0, 0.0). Ties go to the first-inserted
 * tag, mirroring `Counter.most_common(1)` (stable on equal counts).
 */
function dominant(counter: Map<string, number>): [string, number, number] {
	let total = 0
	let bestTag = ""
	let bestCount = -1

	for (const [tag, count] of counter) {
		total += count

		if (count > bestCount) {
			bestCount = count
			bestTag = tag
		}
	}

	if (total === 0) return ["", 0, 0.0]

	return [bestTag, total, bestCount / total]
}

/** Bump a (key -> count) tally, creating the inner counter on first sight. */
function bump(table: Map<string, Map<string, number>>, key: string, sub: string): void {
	let counter = table.get(key)

	if (!counter) {
		counter = new Map()
		table.set(key, counter)
	}
	counter.set(sub, (counter.get(sub) ?? 0) + 1)
}

/**
 * Read a corpus parquet into rows, projecting only tokens/labels/country. The list columns ride out as JSON text
 * (DuckDB `to_json`) — the same trick build-unified-wof.ts uses for nested columns — and parse back to string arrays
 * here.
 */
async function readRows(con: Awaited<ReturnType<DuckDBInstance["connect"]>>, path: string): Promise<CorpusRow[]> {
	const result = await con.runAndReadAll(
		`SELECT to_json(tokens) AS tokens, to_json(labels) AS labels, country FROM read_parquet('${path}')`
	)
	const raw = result.getRowObjects() as Array<{ tokens: unknown; labels: unknown; country: unknown }>
	const rows: CorpusRow[] = []

	for (const r of raw) {
		const tokens = JSON.parse(String(r.tokens)) as unknown
		const labels = JSON.parse(String(r.labels)) as unknown

		if (!Array.isArray(tokens) || !Array.isArray(labels)) continue
		rows.push({
			tokens: tokens as string[],
			labels: labels as string[],
			country: r.country == null ? null : String(r.country),
		})
	}

	return rows
}

/** Read just the first row's `source` value — used to group base parts for a proportional slice. */
async function readSource(con: Awaited<ReturnType<DuckDBInstance["connect"]>>, path: string): Promise<string> {
	const result = await con.runAndReadAll(`SELECT source FROM read_parquet('${path}') LIMIT 1`)
	const rows = result.getRowObjects() as Array<{ source: unknown }>

	return rows.length ? String(rows[0]!.source) : ""
}

/** Non-recursive `*.parquet` glob, sorted lexicographically — the Python `sorted(glob.glob(...))`. */
function globParquet(dir: string): string[] {
	let names: string[]

	try {
		names = readdirSync(dir)
	} catch {
		return []
	}

	return names
		.filter((f) => f.endsWith(".parquet"))
		.map((f) => join(dir, f))
		.sort()
}

interface Args {
	shard: string
	baseVersion: string
	baseRoot: string
	threshold: number
	minCount: number
	fraction: number
}

function parseCLIArgs(): Args {
	const { values } = parseArgs({
		options: {
			shard: { type: "string" },
			"base-version": { type: "string", default: "v0.5.0" },
			"base-root": { type: "string", default: dataRootPath("corpus", "versioned") },
			threshold: { type: "string", default: "0.7" },
			"min-count": { type: "string", default: "50" },
			fraction: { type: "string", default: "1.0" },
		},
	})

	if (!values.shard) {
		console.error(
			"Usage: lint-shard-vocab.ts --shard <shard.parquet> [--base-version v0.5.0] [--base-root <dir>] [--fraction 1.0] [--threshold 0.7] [--min-count 50]"
		)
		process.exit(2)
	}

	return {
		shard: values.shard,
		baseVersion: values["base-version"]!,
		baseRoot: values["base-root"]!,
		threshold: Number(values.threshold),
		minCount: Number.parseInt(values["min-count"]!, 10),
		fraction: Number(values.fraction),
	}
}

async function main(): Promise<void> {
	const args = parseCLIArgs()

	const instance = await DuckDBInstance.create()
	const con = await instance.connect()

	// 1. the shard's own (token -> dominant tag) + the COUNTRIES it uses each token in
	const shardRows = await readRows(con, args.shard)
	const shardTags = new Map<string, Map<string, number>>()
	const shardCountries = new Map<string, Set<string | null>>()

	for (const { tokens, labels, country } of shardRows) {
		const n = Math.min(tokens.length, labels.length)

		for (let i = 0; i < n; i++) {
			const w = tokens[i]!
			const l = labels[i]!

			if (isDigit(w)) continue // numbers are context-determined (house_number/postcode), not lexical vocab
			bump(shardTags, w, stripBIO(l))
			let set = shardCountries.get(w)

			if (!set) {
				set = new Set()
				shardCountries.set(w, set)
			}
			set.add(country)
		}
	}
	const shardVocab = new Set(shardTags.keys())
	console.log(`shard: ${shardRows.length} rows, ${shardVocab.size} unique tokens`)

	// 2. base parts — FULL by default; --fraction<1 takes a proportional per-source slice (still big)
	const trainDir = join(args.baseRoot, args.baseVersion, `corpus-${args.baseVersion}`, "train")
	let parts = globParquet(trainDir)

	if (!parts.length) {
		console.error("no base parts found")
		process.exit(1)
	}

	if (args.fraction < 1.0) {
		const bysrc = new Map<string, string[]>()

		for (const p of parts) {
			const src = await readSource(con, p)
			let list = bysrc.get(src)

			if (!list) {
				list = []
				bysrc.set(src, list)
			}
			list.push(p)
		}
		const sliced: string[] = []

		for (const ps of bysrc.values()) {
			const take = Math.max(2, pyRound(ps.length * args.fraction))

			for (const p of ps.slice(0, take)) {
				sliced.push(p)
			}
		}
		parts = sliced
	}
	console.log(
		`base ${args.baseVersion}: scanning ${parts.length} parts (fraction=${pyFloat(args.fraction)}), COUNTRY-scoped`
	)

	// 3. tally each shard token's base tag, SCOPED to the country the shard uses it in
	const baseTags = new Map<string, Map<string, number>>()

	for (let i = 0; i < parts.length; i++) {
		const rows = await readRows(con, parts[i]!)

		for (const { tokens, labels, country } of rows) {
			const n = Math.min(tokens.length, labels.length)

			for (let j = 0; j < n; j++) {
				const w = tokens[j]!

				if (shardVocab.has(w) && shardCountries.get(w)!.has(country)) {
					bump(baseTags, w, stripBIO(labels[j]!))
				}
			}
		}

		if ((i + 1) % 100 === 0) {
			console.log(`  ...${i + 1}/${parts.length} parts`)
		}
	}

	// 4. compare; flag contradictions (affix-split is expected — surfaced but tagged)
	type Row = [string, string, string, number, number] // w, s_tag, b_tag, b_frac, b_total
	const flagged: Row[] = []
	const affix: Row[] = []

	for (const w of shardVocab) {
		const [sTag] = dominant(shardTags.get(w)!)
		const [bTag, bTotal, bFrac] = dominant(baseTags.get(w) ?? new Map())

		if (bTotal < args.minCount || !bTag || bTag === sTag || bFrac < args.threshold) continue
		const row: Row = [w, sTag, bTag, bFrac, bTotal]

		if ((sTag === "street_suffix" || sTag === "street_prefix") && bTag === "street") {
			affix.push(row)
		} else {
			flagged.push(row)
		}
	}

	const sections: Array<[string, Row[]]> = [
		["CONTRADICTION", flagged],
		["affix-split (EXPECTED — affix-relabel handles)", affix],
	]

	for (const [label, rows] of sections) {
		if (!rows.length) continue
		rows.sort((a, b) => b[4] - a[4] || b[3] - a[3])
		console.log(`\n${label.startsWith("CONTRA") ? "⚠️ " : "· "}${rows.length} ${label}:`)

		for (const [w, sTag, bTag, bFrac, bTotal] of rows) {
			console.log(`  ${pad(w, 18)} shard=${pad(sTag, 14)} base=${bTag} (${pct(bFrac)}, n=${bTotal})`)
		}
	}

	if (!flagged.length) {
		console.log(
			`\n✅ NO real contradictions (country-scoped, threshold ${pct(args.threshold)}, support ${args.minCount}) — shard base-consistent`
		)
	}
	process.exit(flagged.length ? 1 : 0)
}

main()
