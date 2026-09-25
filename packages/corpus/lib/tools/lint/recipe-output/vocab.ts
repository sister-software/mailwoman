/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   #511 base-consistency lint, generalized + country-scoped (v2) — any synthetic recipe output vs
 *   the base.
 *
 *   Ported from the Python original (pyarrow → @duckdb/node-api); behavior preserved
 *   byte-for-byte (same flags, same stdout, same verdicts). The base-root default routes through
 *   `dataRootPath` so the lab `$MAILWOMAN_DATA_ROOT` literal stays in its one home
 *   (core/utils/data-root.ts) and `$MAILWOMAN_DATA_ROOT` is honored. with the env unset it equals
 *   the Python default.
 *
 *   The #511 lesson: a synthetic recipe output must not label a token a tag the base dominantly
 *   labels something else, or training gets conflicting gradients on the same token and the minority
 *   (the recipe output) loses. This reads a recipe output's own (token -> tag) and checks each token
 *   against the base.
 *
 *   Why v2 is country-scoped + full-count (the night-2026-06-18 lesson, learned the hard way over
 *   three tries): a token's correct tag is country-specific — "Paris" is locality in FR data and
 *   street in US "Paris Ave"; "Marion" is a US town and many US "Marion" streets. So:
 *
 *   1. A cross-country aggregate mis-judges any country-specific token (v1 uniform and a proportional
 *        retry both false-flagged FR cities as "street" from US street-contexts).
 *   2. A small sample is street-biased regardless, because the street sources (tiger 39 + nad 378 parts)
 *        dwarf the locality sources (a small US-scoped spot-check read Indianapolis 54% street vs
 *        its true 219700:29 locality). The fix: tally each recipe-output token's base tag scoped to
 *        the country the recipe output uses it in (the base has a `country` column), over a
 *        large/full scan (`fraction`, default 1.0). Pure-numeric tokens excluded (house_number/postcode
 *        are context-determined). An affix-split flag (recipe output street_suffix/_prefix vs base
 *        "street") is expected — the loader's affix-relabel handles it. weigh those separately.
 *
 *   Usage: mailwoman dev lint slice-vocab --slice <recipe-output.parquet>
 *   [--base-version v0.5.0] [--base-root <dir>] [--fraction 1.0] [--threshold 0.7] [--min-count
 *   50]
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { tryParsingJSON } from "@mailwoman/core/json"
import { pyRound } from "@mailwoman/core/numeric"
import { PathBuilder } from "path-ts"
import { Globerator } from "spliterator/node/fs"

import { type DuckDBConnection, openDuckDB } from "#parquet/duckdb"

/**
 * A column-projected base or recipe-output row: parallel token + label lists plus the row's country.
 */
interface CorpusRow {
	tokens: string[]
	labels: string[]
	country: string | null
}

/**
 * Strip a BIO prefix ("B-"/"I-") off a label, matching the Python `strip_bio`.
 */
function stripBIO(label: string): string {
	const head = label.slice(0, 2)

	return head === "B-" || head === "I-" ? label.slice(2) : label
}

/**
 * Python `str.isdigit()`: non-empty and every character a Unicode digit.
 *
 * Pure-numeric tokens (house_number / postcode) are context-determined
 * rather than lexical vocab, so they're excluded.
 * `\p{Nd}` covers the decimal digits these address corpora actually contain.
 */
function isDigit(token: string): boolean {
	return token.length > 0 && /^\p{Nd}+$/u.test(token)
}

/**
 * Format a fraction as a whole-percent string the way Python's `:.0%` does, e.g. 0.73 -> "73%".
 */
function pct(frac: number): string {
	return `${pyRound(frac * 100)}%`
}

/**
 * Format a float the way a Python f-string renders it: integer-valued floats keep one
 * decimal (1.0 -> "1.0"), everything else is its shortest decimal (0.5 -> "0.5").
 *
 * Used for the `fraction` echo so the banner matches the Python print.
 */
function formatPyFloat(n: number): string {
	return Number.isInteger(n) ? n.toFixed(1) : String(n)
}

/**
 * Left-justify to a minimum width with spaces, matching Python's `{value:N}` string field.
 */
function pad(value: string, width: number): string {
	return value.padEnd(width)
}

/**
 * The dominant tag of a counter: (tag, total, fraction).
 *
 * Empty counter -> ("", 0, 0.0).
 * Ties go to the first-inserted tag, mirroring `Counter.most_common(1)` (stable on equal counts).
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

	if (total === 0) return ["", 0, 0]

	return [bestTag, total, bestCount / total]
}

/**
 * Bump a (key -> count) tally, creating the inner counter on first sight.
 */
function bump(table: Map<string, Map<string, number>>, key: string, sub: string): void {
	let counter = table.get(key)

	if (!counter) {
		counter = new Map()
		table.set(key, counter)
	}

	counter.set(sub, (counter.get(sub) ?? 0) + 1)
}

/**
 * Read a corpus parquet into rows, projecting only tokens/labels/country.
 *
 * The list columns ride out as JSON text (DuckDB `to_json`) — the same trick the gazetteer
 * builders use for nested columns — and parse back to string arrays here.
 */
async function readRows(con: DuckDBConnection, path: string): Promise<CorpusRow[]> {
	const result = await con.runAndReadAll(
		`SELECT to_json(tokens) AS tokens, to_json(labels) AS labels, country FROM read_parquet('${path}')`
	)

	const raw = result.getRowObjects() as Array<{ tokens: unknown; labels: unknown; country: unknown }>
	const rows: CorpusRow[] = []

	for (const r of raw) {
		const tokens = tryParsingJSON(String(r.tokens))
		const labels = tryParsingJSON(String(r.labels))

		if (!Array.isArray(tokens) || !Array.isArray(labels)) continue

		rows.push({
			tokens: tokens as string[],
			labels: labels as string[],
			country: r.country == null ? null : String(r.country),
		})
	}

	return rows
}

/**
 * Read just the first row's `source` value — used to group base parts for a proportional sample.
 */
async function readSource(con: DuckDBConnection, path: string): Promise<string> {
	const result = await con.runAndReadAll(`SELECT source FROM read_parquet('${path}') LIMIT 1`)
	const rows = result.getRowObjects() as Array<{ source: unknown }>

	return rows.length ? String(rows[0]!.source) : ""
}

/**
 * Options for {@linkcode lintRecipeVocab}.
 */
export interface LintRecipeVocabOptions {
	/**
	 * The recipe output parquet to lint.
	 */
	recipeOutputPath: string
	/**
	 * Base corpus version.
	 *
	 * Default `v0.5.0`.
	 */
	baseVersion?: string
	/**
	 * Base corpus root.
	 *
	 * Default `$MAILWOMAN_DATA_ROOT/corpus/versioned`.
	 */
	baseRoot?: string
	/**
	 * Base-majority confidence floor for a contradiction.
	 *
	 * Default 0.7.
	 */
	threshold?: number
	/**
	 * Minimum base support to judge a token.
	 *
	 * Default 50.
	 */
	minCount?: number
	/**
	 * Fraction of base parts to scan (proportional per-source sample below 1.0).
	 *
	 * Default 1.0.
	 */
	fraction?: number
}

/**
 * One contradiction row: token, recipe-output tag, base tag, base fraction, base total.
 */
export type VocabRow = [token: string, outputTag: string, baseTag: string, baseFrac: number, baseTotal: number]

/**
 * Findings summary returned by {@linkcode lintRecipeVocab}.
 */
export interface LintRecipeVocabSummary {
	/**
	 * Real contradictions — the command exits 1 when nonzero.
	 */
	errors: number
	/**
	 * Affix-split rows (expected — the loader's affix-relabel handles them).
	 */
	warnings: number
	findings: { contradictions: VocabRow[]; affixSplits: VocabRow[] }
}

/**
 * Lint a synthetic recipe output's (token → tag) vocabulary against the base corpus, country-scoped.
 */
export async function lintRecipeVocab(options: LintRecipeVocabOptions): Promise<LintRecipeVocabSummary> {
	const baseVersion = options.baseVersion ?? "v0.5.0"
	const baseRoot = PathBuilder.from(options.baseRoot ?? dataRootPath("corpus", "versioned"))
	const threshold = options.threshold ?? 0.7
	const minCount = options.minCount ?? 50
	const fraction = options.fraction ?? 1

	using con = await openDuckDB()

	// 1. the recipe output's own (token -> dominant tag) + the countries it uses each token in
	const outputRows = await readRows(con, options.recipeOutputPath)
	const outputTags = new Map<string, Map<string, number>>()
	const outputCountries = new Map<string, Set<string | null>>()

	for (const { tokens, labels, country } of outputRows) {
		const n = Math.min(tokens.length, labels.length)

		for (let i = 0; i < n; i++) {
			const w = tokens[i]!
			const l = labels[i]!

			if (isDigit(w)) continue // numbers are context-determined (house_number/postcode), not lexical vocab
			bump(outputTags, w, stripBIO(l))
			let set = outputCountries.get(w)

			if (!set) {
				set = new Set()
				outputCountries.set(w, set)
			}

			set.add(country)
		}
	}

	const outputVocab = new Set(outputTags.keys())

	console.log(`recipe output: ${outputRows.length} rows, ${outputVocab.size} unique tokens`)

	// 2. base parts — full by default. fraction<1 takes a proportional per-source sample (still big)
	const trainDir = baseRoot(baseVersion, `corpus-${baseVersion}`, "train")

	let parts = (
		await Globerator.from("*.parquet", {
			cwd: trainDir,
			absolute: true,
		}).toArray()
	).toSorted()

	if (!parts.length) {
		throw new Error("no base parts found")
	}

	if (fraction < 1) {
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

		const sampled: string[] = []

		for (const ps of bysrc.values()) {
			const take = Math.max(2, pyRound(ps.length * fraction))

			for (const p of ps.slice(0, take)) {
				sampled.push(p)
			}
		}

		parts = sampled
	}

	console.log(
		`base ${baseVersion}: scanning ${parts.length} parts (fraction=${formatPyFloat(fraction)}), COUNTRY-scoped`
	)

	// 3. tally each recipe-output token's base tag, scoped to the country the recipe output uses it in
	const baseTags = new Map<string, Map<string, number>>()

	for (let i = 0; i < parts.length; i++) {
		const rows = await readRows(con, parts[i]!)

		for (const { tokens, labels, country } of rows) {
			const n = Math.min(tokens.length, labels.length)

			for (let j = 0; j < n; j++) {
				const w = tokens[j]!

				if (outputVocab.has(w) && outputCountries.get(w)!.has(country)) {
					bump(baseTags, w, stripBIO(labels[j]!))
				}
			}
		}

		if ((i + 1) % 100 === 0) {
			console.log(`  ...${i + 1}/${parts.length} parts`)
		}
	}

	// 4. compare.
	//    Flag contradictions (affix-split is expected — surfaced but tagged)
	const flagged: VocabRow[] = []
	const affix: VocabRow[] = []

	for (const w of outputVocab) {
		const [sTag] = dominant(outputTags.get(w)!)
		const [bTag, bTotal, bFrac] = dominant(baseTags.get(w) ?? new Map())

		if (bTotal < minCount || !bTag || bTag === sTag || bFrac < threshold) continue
		const row: VocabRow = [w, sTag, bTag, bFrac, bTotal]

		if ((sTag === "street_suffix" || sTag === "street_prefix") && bTag === "street") {
			affix.push(row)
		} else {
			flagged.push(row)
		}
	}

	const sections: Array<[string, VocabRow[]]> = [
		["CONTRADICTION", flagged],
		["affix-split (EXPECTED — affix-relabel handles)", affix],
	]

	for (const [label, rows] of sections) {
		if (!rows.length) continue
		rows.sort((a, b) => b[4] - a[4] || b[3] - a[3])

		console.log(`\n${label.startsWith("CONTRA") ? "⚠️ " : "· "}${rows.length} ${label}:`)

		for (const [w, sTag, bTag, bFrac, bTotal] of rows) {
			console.log(`  ${pad(w, 18)} output=${pad(sTag, 14)} base=${bTag} (${pct(bFrac)}, n=${bTotal})`)
		}
	}

	if (!flagged.length) {
		console.log(
			`\n✅ NO real contradictions (country-scoped, threshold ${pct(threshold)}, support ${minCount}) — recipe output base-consistent`
		)
	}

	return {
		errors: flagged.length,
		warnings: affix.length,
		findings: { contradictions: flagged, affixSplits: affix },
	}
}
