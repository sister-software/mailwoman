/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Convert a jsonl of LabeledRow objects to a Parquet file matching the v0.5.0 schema.
 *
 *   Ported faithfully from scripts/jsonl-to-parquet.py. The Python original wrote Parquet through
 *   PyArrow. this writes it through DuckDB (`@duckdb/node-api`) — `read_json` with an explicit
 *   `columns` type map projects the validated rows to the v0.5.0 schema, then `copy … TO … (format
 *   parquet, compression snappy, ROW_GROUP_SIZE …)` emits the file. DuckDB reproduces the exact
 *   logical schema PyArrow did — `varchar` (UTF8) scalars, `varchar[]` (list<UTF8>) for the string
 *   arrays, and `integer[]` (list<INT32>) for the span offsets — in the exact column order below.
 *   Verified field-for-field against the PyArrow original (same column order, same logical types,
 *   same `list<element: …>` child naming, same values), so a PyArrow reader sees an identical
 *   table. The trainer in any case reads parquet files by column name (`pq.read_table(...).to_pylist()`),
 *   which is blind to physical layout. INT32 matches the corpus's native TS writer
 *   (`@mailwoman/corpus` `LABELED_ROW_SCHEMA`), which already writes the base files this overlay
 *   rides alongside.
 *
 *   Schema: `PARQUET_COLUMNS` from `#parquet/schema`, which is the same list the native writer uses.
 *
 *   The span triple (#519, v0.5.0 char-offset labels) is required on every row: `alignRow` emits it
 *   on every labeled row, so a row arriving without it came from a producer that hasn't migrated —
 *   writing it would silently drop the v0.5.0 labels from the file. Loud failure, naming the row
 *   number, instead.
 *
 *   Usage: mailwoman dev jsonl-to-parquet --input /tmp/po-box-labeled.jsonl --output
 *   /tmp/part-po-box.parquet
 */

import { delimitedSource } from "@mailwoman/core/fs/delimited"
import { openWriteStream } from "@mailwoman/core/fs/streams"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { parseJSONStrict, stringifyJSON } from "@mailwoman/core/json"
import { join, type PathBuilderLike } from "path-ts"
import { TextSpliterator } from "spliterator"

import { connectDuckDB, escapeSQLString } from "#parquet/duckdb"
import { PARQUET_COLUMNS, PARQUET_COLUMN_TYPES } from "#parquet/schema"

/**
 * The columns this converter writes, and the DuckDB type each is written as.
 *
 * Both come from `#parquet/schema`, which is the one definition the native writer,
 * the reader and the manifest already share.
 * This file restated them, and the restatement went stale the moment `synth_method` became
 * `recipe`, `register` and `surface`: an overlay converted here would have been written
 * without the three columns the base files carry, and the loader reads by column name
 * rather than by position, so the rows would have arrived declaring no surface at all.
 *
 * The span offsets are INT32 (#519): parallel arrays over `raw`
 * (UTF-16 code units, `[start, end)` exclusive-end, sorted, non-overlapping).
 * `raw` is a short address string, so INT32 round-trips as a plain integer
 * where INT64 would surface as bigint.
 */
const REQUIRED_COLUMNS = PARQUET_COLUMNS
const COLUMN_TYPES = PARQUET_COLUMN_TYPES

const SPAN_COLUMNS = ["span_starts", "span_ends", "span_tags"] as const

/**
 * Options for {@linkcode jsonlToParquet}.
 */
export interface JSONLToParquetOptions {
	/**
	 * The labeled-row jsonl to convert.
	 */
	input: PathBuilderLike
	/**
	 * The parquet file to write.
	 */
	output: PathBuilderLike
	/**
	 * Parquet row-group size.
	 *
	 * Default 50000.
	 */
	rowGroupSize?: number
}

/**
 * Summary returned by {@linkcode jsonlToParquet}.
 */
export interface JSONLToParquetSummary {
	read: number
	written: number
	outPath: string
}

/**
 * Enforce the #519 span interface per row: all three present, parallel lengths.
 *
 * A row with span_starts but no span_tags is a corrupt row, never a silent fallback.
 */
function assertSpanTriple(row: Record<string, unknown>, lineNo: number): void {
	const present = SPAN_COLUMNS.filter((c) => row[c] != null)

	if (present.length !== SPAN_COLUMNS.length) {
		const missing = SPAN_COLUMNS.filter((c) => row[c] == null)
		throw new Error(
			`line ${lineNo}: row is missing the char-offset span triple (#519): ` +
				`missing ${stringifyJSON(missing)} (source_id=${stringifyJSON(row.source_id ?? null)}). Every parquet-bound row ` +
				"must carry span_starts/span_ends/span_tags; re-emit this file through alignRow."
		)
	}

	const n = (row.span_starts as unknown[]).length

	if ((row.span_ends as unknown[]).length !== n || (row.span_tags as unknown[]).length !== n) {
		throw new Error(
			`line ${lineNo}: span triple arrays are not parallel — ` +
				`starts=${(row.span_starts as unknown[]).length} ends=${(row.span_ends as unknown[]).length} ` +
				`tags=${(row.span_tags as unknown[]).length} (source_id=${stringifyJSON(row.source_id ?? null)})`
		)
	}
}

/**
 * Convert a labeled-row jsonl to a v0.5.0-schema Parquet file.
 */
export async function jsonlToParquet(
	options: JSONLToParquetOptions,
	report?: (line: string) => void
): Promise<JSONLToParquetSummary> {
	const rowGroupSize = options.rowGroupSize ?? 50_000

	if (!Number.isInteger(rowGroupSize) || rowGroupSize <= 0) {
		throw new Error(`rowGroupSize must be a positive integer (got ${stringifyJSON(rowGroupSize)})`)
	}

	// Stage the validated rows to a temp ndjson, then let DuckDB type + write them.
	// Streaming keeps memory O(1) on the Node side (the Python original buffered every column into memory first).
	// The staging directory owns the write stream, so it is closed before the directory
	// is removed, and a mid-stream span-triple failure leaves no orphan.
	await using staging = await temporaryDirectory("mw-jsonl-to-parquet-")
	const stagePath = join(staging.path, "rows.ndjson")
	const stage = staging.use(openWriteStream(stagePath, { encoding: "utf8" }))

	let rows = 0
	let lineNo = 0

	// TextSpliterator rather than JSONSpliterator: the staging write below streams
	// the RAW line bytes to DuckDB verbatim (the parse here only validates),
	// so a re-serialized JSONSpliterator row would defeat the point.
	// Crlf is handled by the existing `rawLine.trim()` (strips a trailing \r),
	// same as readline's crlfDelay:Infinity did.
	for await (const rawLine of TextSpliterator.fromAsync(delimitedSource(options.input))) {
		lineNo++
		const line = rawLine.trim()

		if (!line) continue
		const row = parseJSONStrict<Record<string, unknown>>(line)
		assertSpanTriple(row, lineNo)
		// Write the validated line verbatim.
		// DuckDB's `read_json` projects to the explicit `columns` map below
		// (extra keys dropped, absent keys → NULL — matching the Python `row.get(c)`).
		stage.write(line + "\n")

		rows++
	}

	await new Promise<void>((resolve, reject) => {
		stage.end((err?: Error | null) => (err ? reject(err) : resolve()))
	})

	report?.(`Read ${rows} rows from ${options.input}`)

	const columnsLiteral = "{" + REQUIRED_COLUMNS.map((c) => `'${c}': '${COLUMN_TYPES[c]}'`).join(", ") + "}"
	const selectList = REQUIRED_COLUMNS.join(", ")

	const output = options.output.toString()
	const db = await connectDuckDB()
	// Row order is required: the overlay-manifest assembler records first/last source_id from file order.
	// `preserve_insertion_order` (DuckDB default) keeps output order = input order.
	await db.run("SET preserve_insertion_order=true")

	await db.run(
		`COPY (SELECT ${selectList} FROM read_json('${escapeSQLString(stagePath)}', ` +
			`columns = ${columnsLiteral}, format = 'newline_delimited')) ` +
			`TO '${escapeSQLString(output)}' (FORMAT PARQUET, COMPRESSION SNAPPY, ROW_GROUP_SIZE ${rowGroupSize})`
	)

	const counted = await db.runAndReadAll(`SELECT count(*) AS n FROM read_parquet('${escapeSQLString(output)}')`)
	const written = Number(counted.getRowObjects()[0]!.n)
	report?.(`Wrote ${written} rows to ${output}`)

	return { read: rows, written, outPath: output }
}
