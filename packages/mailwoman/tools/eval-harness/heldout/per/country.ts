/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Per-country accuracy of two or more models on the same held-out corpus rows.
 *
 *   The regression board holds rows for the locales the model already served, so a corpus change that adds
 *   countries shows its gains only where the board happens to hold a row. This grader reads rows that
 *   `corpus split-slice` routed to the test split and scores every arm on the same rows. Each row is parsed
 *   with its own country as the locale hint.
 *
 *   Every arm records one outcome per row, keyed by a stable row identity, so a later step can compute paired
 *   differences between the published model and a candidate. The primary outcome is exact parse correctness
 *   (`score/exact-parse`). Two diagnostics remain: a gold span counts as recovered when the parse holds its
 *   text, folded, under the same tag, and `goldRecovered` marks a row whose every gold span was recovered,
 *   which permits additional predictions and is therefore not exact parse accuracy.
 */

import type { AddressTree } from "@mailwoman/core/decoder"
import { groupTuplesByTag, walkNodes } from "@mailwoman/core/decoder"
import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { sha256Hex } from "@mailwoman/core/hash"
import { stringifyJSON } from "@mailwoman/core/json"
import { escapeSQLString, openDuckDB } from "@mailwoman/corpus/parquet/duckdb"
import { normalizeDuckDBValue } from "@mailwoman/corpus/parquet/streams"
import { NeuralAddressClassifier } from "@mailwoman/neural"
import { foldCaseWhitespace } from "@mailwoman/normalize/fold"
import type { PathBuilderLike } from "path-ts"

import { scoreExactParse, validateAnnotatedSpans } from "#tools/eval-harness/score/exact-parse"

/**
 * One held-out row, in the corpus parquet schema.
 */
export interface HeldoutRow {
	raw: string
	span_starts: number[]
	span_ends: number[]
	span_tags: string[]
	country: string | null
	source: string
	source_id: string | null
}

/**
 * The kind of a held-out row; see {@linkcode heldoutRowKind}.
 */
export type HeldoutRowKind = "gazetteer" | "address"

/**
 * What is known about whether either compared model saw a row in training.
 *
 * - `verified_unseen`: a recorded exclusion history shows neither the published model
 *   nor the candidate trained on the row.
 * - `known_overlap`: a recorded history shows at least one of them trained on the row.
 * - `unknown`: no recorded history covers the row.
 *
 * A class other than `unknown` is assigned only from a {@linkcode ProvenanceHistory}
 * entry for the row's identity.
 * Membership in the test split is not evidence: a row moved into the test split by a
 * split repair may have been in the published model's training data.
 */
export type HeldoutProvenance = "verified_unseen" | "known_overlap" | "unknown"

/**
 * A recorded exclusion history entry for one row.
 */
export interface ProvenanceRecord {
	provenance: Exclude<HeldoutProvenance, "unknown">
	/**
	 * Where the history was recorded, such as an overlap audit's artifact path and hash.
	 */
	evidence: string
}

/**
 * Recorded exclusion history keyed by {@linkcode heldoutRowID}.
 */
export type ProvenanceHistory = ReadonlyMap<string, ProvenanceRecord>

/**
 * Available and sampled test rows for one country and row kind.
 */
export interface HeldoutCellCount {
	country: string
	kind: HeldoutRowKind
	available: number
	sampled: number
}

/**
 * One arm's outcome on one row.
 */
export interface HeldoutRowOutcome {
	rowID: string
	country: string
	source: string
	kind: HeldoutRowKind
	provenance: HeldoutProvenance
	/**
	 * The predicted spans equal the annotated spans, with no missing and no additional span.
	 */
	exact: boolean
	missingSpans: number
	additionalSpans: number
	spans: number
	spansRecovered: number
	/**
	 * Every gold span was recovered by folded text; additional predictions are permitted.
	 */
	goldRecovered: boolean
}

/**
 * One country and row kind's totals for one arm.
 */
export interface CountryScore {
	rows: number
	/**
	 * Rows whose predicted spans exactly equal the annotated spans.
	 */
	rowsExactParse: number
	/**
	 * Rows whose every gold span the parse recovered, permitting additional predictions.
	 * A diagnostic.
	 */
	rowsGoldRecovered: number
	spans: number
	spansRecovered: number
}

/**
 * One arm's per-row outcomes, in row order, and their totals keyed `<country>/<kind>`.
 */
export interface HeldoutArmResult {
	rows: HeldoutRowOutcome[]
	cells: Map<string, CountryScore>
}

/**
 * Whether a row is a gazetteer surface or an address, read from its source.
 *
 * Who's On First sources render place names with their admin parents, such as
 * `Wollin, Mecklenburg-Vorpommern`, and make up most of a small country's test rows.
 * Scored together with addresses they set a country's score by the source mix
 * rather than by how the model reads addresses.
 */
export function heldoutRowKind(source: string): HeldoutRowKind {
	return source.startsWith("wof-") ? "gazetteer" : "address"
}

/**
 * A row's stable identity: `<source>:<source_id>`, or `<source>:raw-sha256:<hex>`
 * when the row has no `source_id`.
 */
export function heldoutRowID(row: Pick<HeldoutRow, "source" | "source_id" | "raw">): string {
	return row.source_id ? `${row.source}:${row.source_id}` : `${row.source}:raw-sha256:${sha256Hex(row.raw)}`
}

/**
 * Reads up to `perCountry` test-split rows per country and row kind from a corpus
 * manifest's test files, with the number of test rows available in each cell.
 *
 * The rows of each country are ordered by a hash of their text, so the same
 * corpus yields the same sample on every run.
 *
 * @param pathRoot The local directory that stands for the manifest's `/data` prefix, such as the data root.
 */
export async function sampleHeldoutRows(
	manifestPath: PathBuilderLike,
	perCountry: number,
	pathRoot: string
): Promise<{ rows: HeldoutRow[]; counts: HeldoutCellCount[] }> {
	const manifest = await readLocalJSONFile<{
		slices: Array<{ path: string; split: string }>
	}>(manifestPath)

	const files = manifest.slices
		.filter((slice) => slice.split === "test")
		.map((slice) => slice.path.replace(/^\/data/u, pathRoot))

	if (!files.length) throw new Error(`${manifestPath.toString()} lists no test files`)

	using db = await openDuckDB()
	const source = `read_parquet([${files.map((file) => `'${escapeSQLString(file)}'`).join(", ")}], union_by_name = true)`

	const reader = await db.runAndReadAll(
		`SELECT raw, span_starts, span_ends, span_tags, country, source, source_id FROM ${source} ` +
			// Each country draws its quota of address rows and of gazetteer rows separately (`heldoutRowKind`).
			`QUALIFY row_number() OVER (PARTITION BY coalesce(country, 'ZZ'), starts_with(source, 'wof-') ORDER BY hash(raw)) <= ` +
			Math.trunc(perCountry).toString()
	)

	const availableReader = await db.runAndReadAll(
		`SELECT coalesce(country, 'ZZ') AS country, starts_with(source, 'wof-') AS gazetteer, count(*) AS n FROM ${source} GROUP BY ALL`
	)

	const spanList = (value: unknown): unknown[] => {
		const normalized = normalizeDuckDBValue(value)

		if (!Array.isArray(normalized))
			throw new Error(`a held-out row holds a non-list span column: ${String(normalized)}`)

		return normalized
	}

	const rows = reader.getRowObjects().map((row): HeldoutRow => ({
		raw: String(row.raw),
		span_starts: spanList(row.span_starts).map(Number),
		span_ends: spanList(row.span_ends).map(Number),
		span_tags: spanList(row.span_tags).map((tag) => {
			if (typeof tag !== "string") throw new Error(`a held-out row holds a non-string span tag: ${stringifyJSON(tag)}`)

			return tag
		}),
		country: row.country == null ? null : String(row.country),
		source: String(row.source),
		source_id: row.source_id == null ? null : String(row.source_id),
	}))

	const available = availableReader.getRowObjects().map((row) => ({
		country: String(row.country),
		kind: (row.gazetteer === true ? "gazetteer" : "address") as HeldoutRowKind,
		available: Number(row.n),
	}))

	return { rows, counts: countHeldoutCells(available, rows) }
}

/**
 * Joins each cell's available test-row count with the number of sampled rows in it.
 */
export function countHeldoutCells(
	available: ReadonlyArray<{
		country: string
		kind: HeldoutRowKind
		available: number
	}>,
	sampled: readonly HeldoutRow[]
): HeldoutCellCount[] {
	const counts = new Map<string, HeldoutCellCount>()

	for (const cell of available) {
		counts.set(`${cell.country}/${cell.kind}`, { ...cell, sampled: 0 })
	}

	for (const row of sampled) {
		const key = `${row.country ?? "ZZ"}/${heldoutRowKind(row.source)}`
		const cell = counts.get(key)

		if (!cell) throw new Error(`sampled row ${heldoutRowID(row)} falls in ${key}, which the availability count lacks`)

		cell.sampled++
	}

	return [...counts.values()].toSorted((a, b) => `${a.country}/${a.kind}`.localeCompare(`${b.country}/${b.kind}`))
}

/**
 * Scores one parse of one row.
 */
export function scoreHeldoutRow(row: HeldoutRow, tree: AddressTree, history?: ProvenanceHistory): HeldoutRowOutcome {
	const rowID = heldoutRowID(row)
	const annotated = validateAnnotatedSpans(row, rowID)
	const exactOutcome = scoreExactParse(row.raw, annotated, [...walkNodes(tree.roots)])
	const byTag = groupTuplesByTag(tree)

	let spansRecovered = 0

	for (const [i, tag] of row.span_tags.entries()) {
		const gold = foldCaseWhitespace(row.raw.slice(row.span_starts[i], row.span_ends[i]))

		if ((byTag.get(tag) ?? []).some((value) => foldCaseWhitespace(value) === gold)) {
			spansRecovered++
		}
	}

	return {
		rowID,
		country: row.country ?? "ZZ",
		source: row.source,
		kind: heldoutRowKind(row.source),
		provenance: history?.get(rowID)?.provenance ?? "unknown",
		exact: exactOutcome.exact,
		missingSpans: exactOutcome.missing.length,
		additionalSpans: exactOutcome.additional.length,
		spans: row.span_tags.length,
		spansRecovered,
		goldRecovered: spansRecovered === row.span_tags.length,
	}
}

/**
 * Scores one arm over every row, given a parse function.
 *
 * Refuses rows that share an identity, because paired outcomes are joined by identity.
 */
export async function scoreHeldoutArm(
	rows: readonly HeldoutRow[],
	parse: (row: HeldoutRow) => Promise<AddressTree>,
	history?: ProvenanceHistory
): Promise<HeldoutArmResult> {
	const outcomes: HeldoutRowOutcome[] = []
	const cells = new Map<string, CountryScore>()
	const seen = new Set<string>()

	for (const row of rows) {
		const outcome = scoreHeldoutRow(row, await parse(row), history)

		if (seen.has(outcome.rowID)) {
			throw new Error(`two held-out rows share the identity ${outcome.rowID}`)
		}

		seen.add(outcome.rowID)
		outcomes.push(outcome)

		const key = `${outcome.country}/${outcome.kind}`

		const cell = cells.get(key) ?? {
			rows: 0,
			rowsExactParse: 0,
			rowsGoldRecovered: 0,
			spans: 0,
			spansRecovered: 0,
		}

		cell.rows++
		cell.spans += outcome.spans
		cell.spansRecovered += outcome.spansRecovered

		if (outcome.exact) {
			cell.rowsExactParse++
		}

		if (outcome.goldRecovered) {
			cell.rowsGoldRecovered++
		}

		cells.set(key, cell)
	}

	return { rows: outcomes, cells }
}

/**
 * Throws unless every arm scored the same row identities in the same order.
 */
export function assertPairedArms(arms: readonly HeldoutArmResult[]): void {
	const [first, ...rest] = arms

	if (!first) throw new Error("no arms to pair")

	for (const [index, arm] of rest.entries()) {
		if (arm.rows.length !== first.rows.length) {
			throw new Error(`arm ${index + 1} scored ${arm.rows.length} rows; arm 0 scored ${first.rows.length}`)
		}

		for (const [i, outcome] of arm.rows.entries()) {
			if (outcome.rowID !== first.rows[i]!.rowID) {
				throw new Error(`arm ${index + 1} row ${i} is ${outcome.rowID}; arm 0 row ${i} is ${first.rows[i]!.rowID}`)
			}
		}
	}
}

/**
 * Scores one model, loaded from a package-shaped weights directory as `mwdev_arc` takes, over every row.
 */
export async function scoreHeldoutWeights(
	rows: readonly HeldoutRow[],
	cacheRoot: string,
	history?: ProvenanceHistory
): Promise<HeldoutArmResult> {
	const classifier = await NeuralAddressClassifier.loadFromWeights({
		locale: "en-US",
		cacheRoot,
	})

	return scoreHeldoutArm(
		rows,
		(row) =>
			classifier.parse(row.raw, {
				postcodeRepair: true,
				...(row.country ? { localeHint: row.country } : {}),
			}),
		history
	)
}
