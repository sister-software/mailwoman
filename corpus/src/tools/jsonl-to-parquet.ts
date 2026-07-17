/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Convert a JSONL of LabeledRow objects to a Parquet shard matching the v0.5.0 schema.
 *
 *   Ported faithfully from scripts/jsonl-to-parquet.py. The Python original wrote Parquet through
 *   PyArrow; this writes it through DuckDB (`@duckdb/node-api`) — `read_json` with an EXPLICIT
 *   `columns` type map projects the validated rows to the v0.5.0 schema, then `COPY … TO … (FORMAT
 *   PARQUET, COMPRESSION SNAPPY, ROW_GROUP_SIZE …)` emits the shard. DuckDB reproduces the exact
 *   logical schema PyArrow did — `VARCHAR` (UTF8) scalars, `VARCHAR[]` (LIST<UTF8>) for the string
 *   arrays, and `INTEGER[]` (LIST<INT32>) for the span offsets — in the exact column order below.
 *   Verified field-for-field against the PyArrow original (same column order, same logical types,
 *   same `list<element: …>` child naming, same values), so a PyArrow reader sees an identical
 *   table. The trainer in any case reads shards by column name (`pq.read_table(...).to_pylist()`),
 *   which is blind to physical layout. INT32 matches the corpus's native TS writer
 *   (`@mailwoman/corpus` `LABELED_ROW_SCHEMA`), which already writes the base shards this overlay
 *   rides alongside.
 *
 *   Schema: raw, tokens, labels, span_starts, span_ends, span_tags, country, locale, source,
 *   source_id, corpus_version, license, synth_method, synth_base_id.
 *
 *   The span triple (#519, v0.5.0 char-offset labels) is REQUIRED on every row: `alignRow` emits it
 *   on every labeled row, so a row arriving without it came from a producer that hasn't migrated —
 *   writing it would silently drop the v0.5.0 labels from the shard. Loud failure, naming the row
 *   number, instead.
 *
 *   Usage: mailwoman dev jsonl-to-parquet --input /tmp/po-box-labeled.jsonl --output
 *   /tmp/part-po-box.parquet
 */

import { randomUUID } from "node:crypto"
import { createWriteStream } from "node:fs"
import { unlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { TextSpliterator } from "spliterator"

const REQUIRED_COLUMNS = [
	"raw",
	"tokens",
	"labels",
	"span_starts",
	"span_ends",
	"span_tags",
	"country",
	"locale",
	"source",
	"source_id",
	"corpus_version",
	"license",
	"synth_method",
	"synth_base_id",
] as const

const SPAN_COLUMNS = ["span_starts", "span_ends", "span_tags"] as const

/**
 * The v0.5.0 DuckDB type for each column, in {@link REQUIRED_COLUMNS} order.
 *
 * Mirrors the PyArrow schema the Python original declared: `pa.string()` → `VARCHAR`, `pa.list_(pa.string())` →
 * `VARCHAR[]`, `pa.list_(pa.int32())` → `INTEGER[]`. The span offsets are INT32 (#519): parallel arrays over `raw`
 * (UTF-16 code units, `[start, end)` exclusive-end, sorted, non-overlapping); `raw` is a short address string, so INT32
 * round-trips as a plain integer where INT64 would surface as bigint.
 */
const COLUMN_TYPES: Record<(typeof REQUIRED_COLUMNS)[number], string> = {
	raw: "VARCHAR",
	tokens: "VARCHAR[]",
	labels: "VARCHAR[]",
	span_starts: "INTEGER[]",
	span_ends: "INTEGER[]",
	span_tags: "VARCHAR[]",
	country: "VARCHAR",
	locale: "VARCHAR",
	source: "VARCHAR",
	source_id: "VARCHAR",
	corpus_version: "VARCHAR",
	license: "VARCHAR",
	synth_method: "VARCHAR",
	synth_base_id: "VARCHAR",
}

/** Options for {@linkcode jsonlToParquet}. */
export interface JSONLToParquetOptions {
	/** The labeled-row JSONL to convert. */
	input: string
	/** The parquet shard to write. */
	output: string
	/** Parquet row-group size. Default 50000. */
	rowGroupSize?: number
}

/** Summary returned by {@linkcode jsonlToParquet}. */
export interface JSONLToParquetSummary {
	read: number
	written: number
	outPath: string
}

/**
 * Enforce the #519 span contract per row: all three present, parallel lengths.
 *
 * A row with span_starts but no span_tags is a corrupt row — never a silent fallback.
 */
function assertSpanTriple(row: Record<string, unknown>, lineNo: number): void {
	const present = SPAN_COLUMNS.filter((c) => row[c] != null)

	if (present.length !== SPAN_COLUMNS.length) {
		const missing = SPAN_COLUMNS.filter((c) => row[c] == null)
		throw new Error(
			`line ${lineNo}: row is missing the char-offset span triple (#519): ` +
				`missing ${JSON.stringify(missing)} (source_id=${JSON.stringify(row.source_id ?? null)}). Every parquet-bound row ` +
				"must carry span_starts/span_ends/span_tags; re-emit this shard through alignRow."
		)
	}
	const n = (row.span_starts as unknown[]).length

	if ((row.span_ends as unknown[]).length !== n || (row.span_tags as unknown[]).length !== n) {
		throw new Error(
			`line ${lineNo}: span triple arrays are not parallel — ` +
				`starts=${(row.span_starts as unknown[]).length} ends=${(row.span_ends as unknown[]).length} ` +
				`tags=${(row.span_tags as unknown[]).length} (source_id=${JSON.stringify(row.source_id ?? null)})`
		)
	}
}

/** Escape a path for single-quoted SQL string literals. */
function sqlString(value: string): string {
	return value.replace(/'/g, "''")
}

/** Convert a labeled-row JSONL to a v0.5.0-schema Parquet shard. */
export async function jsonlToParquet(
	options: JSONLToParquetOptions,
	report?: (line: string) => void
): Promise<JSONLToParquetSummary> {
	const rowGroupSize = options.rowGroupSize ?? 50000

	if (!Number.isInteger(rowGroupSize) || rowGroupSize <= 0) {
		throw new Error(`rowGroupSize must be a positive integer (got ${JSON.stringify(rowGroupSize)})`)
	}

	// Stage the validated rows to a temp NDJSON, then let DuckDB type + write them. Streaming keeps
	// memory O(1) on the Node side (the Python original buffered every column into memory first). The
	// `finally` covers the validation pass too, so a mid-stream span-triple failure leaves no orphan.
	const stagePath = join(tmpdir(), `mw-jsonl-to-parquet-${randomUUID()}.ndjson`)
	const stage = createWriteStream(stagePath, { encoding: "utf8" })

	try {
		let rows = 0
		let lineNo = 0

		// TextSpliterator, not JSONSpliterator: the staging write below streams the RAW line bytes to
		// DuckDB verbatim (JSON.parse here only validates), so a re-serialized JSONSpliterator row would
		// defeat the point. CRLF is handled by the existing `rawLine.trim()` (strips a trailing \r),
		// same as readline's crlfDelay:Infinity did.
		for await (const rawLine of TextSpliterator.fromAsync(options.input)) {
			lineNo++
			const line = rawLine.trim()

			if (!line) continue
			const row = JSON.parse(line) as Record<string, unknown>
			assertSpanTriple(row, lineNo)
			// Write the validated line verbatim; DuckDB's `read_json` projects to the explicit `columns`
			// map below (extra keys dropped, absent keys → NULL — matching the Python `row.get(c)`).
			stage.write(line + "\n")
			rows++
		}
		await new Promise<void>((resolve, reject) => stage.end((err?: Error | null) => (err ? reject(err) : resolve())))

		report?.(`Read ${rows} rows from ${options.input}`)

		const columnsLiteral = "{" + REQUIRED_COLUMNS.map((c) => `'${c}': '${COLUMN_TYPES[c]}'`).join(", ") + "}"
		const selectList = REQUIRED_COLUMNS.join(", ")

		// @duckdb/node-api is an optional peer — lazy import (the pipeline convention).
		const { DuckDBInstance } = await import("@duckdb/node-api")
		const instance = await DuckDBInstance.create()
		const db = await instance.connect()
		// Row order is load-bearing: the overlay-manifest assembler records first/last source_id from
		// shard order. `preserve_insertion_order` (DuckDB default) keeps output order = input order.
		await db.run("SET preserve_insertion_order=true")
		await db.run(
			`COPY (SELECT ${selectList} FROM read_json('${sqlString(stagePath)}', ` +
				`columns = ${columnsLiteral}, format = 'newline_delimited')) ` +
				`TO '${sqlString(options.output)}' (FORMAT PARQUET, COMPRESSION SNAPPY, ROW_GROUP_SIZE ${rowGroupSize})`
		)

		const counted = await db.runAndReadAll(`SELECT count(*) AS n FROM read_parquet('${sqlString(options.output)}')`)
		const written = Number(counted.getRowObjects()[0]!.n)
		report?.(`Wrote ${written} rows to ${options.output}`)

		return { read: rows, written, outPath: options.output }
	} finally {
		stage.destroy()
		await unlink(stagePath).catch(() => {})
	}
}
