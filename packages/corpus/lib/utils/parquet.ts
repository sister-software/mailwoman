/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Final output sliceer for the corpus pipeline.
 *
 *   Phase 1 (#9) shipped JSONL slices + a Python (PyArrow) converter as the path to binary Parquet —
 *   bridging until the JS toolchain caught up. Phase 1.5 (#18 §4) replaced that with a native JS
 *   writer. The build pipeline no longer touches Python at all in its hot path; the only remaining
 *   Python is the one-shot `train_tokenizer.py` SentencePiece step.
 *
 *   Compression: `SNAPPY`. The plan in #18 §4 specified `zstd`; parquet-wasm supports SNAPPY,
 *   which is the standard ML-corpus default (and PyArrow's default). Documented in
 *   `DECISIONS.md`.
 *
 *   Layout under `<outputDir>`:
 *
 *   ```
 *   corpus-v<version>/
 *   MANIFEST.json
 *   train/
 *     part-0000.parquet
 *     part-0001.parquet
 *     ...
 *   val/
 *     part-0000.parquet
 *   test/
 *     part-0000.parquet
 * ```
 *
 *   Each slice caps at `rowsPerSlice` (default 1_000_000); within a slice, DuckDB writes row
 *   groups every `ROW_GROUP_SIZE` (50_000) rows per the issue spec. The MANIFEST captures every
 *   slice's path, row count, byte size, and SHA-256 (computed by re-reading the slice once after
 *   close — cheap relative to writing it).
 */

import { tryStat } from "@mailwoman/core/fs/readers"
import { openWriteStream, type WriteStream } from "@mailwoman/core/fs/streams"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalBuffer, writeLocalJSONFile, makeDirectories } from "@mailwoman/core/fs/writers"
import { sha256File } from "@mailwoman/core/hash"
import { once } from "@mailwoman/core/utils/events"
import { Field, Int32, List, Table as ArrowTable, tableToIPC, Utf8, vectorFromArray } from "apache-arrow"
import { Compression, Table as WasmTable, WriterPropertiesBuilder, writeParquet } from "parquet-wasm"
import { join, type PathBuilderLike } from "path-ts"

import type { LabeledRow } from "#types"
import type { SplitName } from "#utils/split"

/**
 * Row groups are written at this cadence within a slice.
 */
export const ROW_GROUP_SIZE = 50_000

/**
 * Escape `value` for a single-quoted SQL string literal; the caller supplies the quotes.
 */
export function escapeSQLString(value: string): string {
	return value.replaceAll("'", "''")
}

/**
 * An open DuckDB connection, re-exported so consumers of {@link connectDuckDB} can name the type without their own
 * static dependency on the optional peer.
 */
export type { DuckDBConnection } from "@duckdb/node-api"

/**
 * Open an in-memory DuckDB connection. `@duckdb/node-api` is an optional peer — lazy import (the pipeline convention),
 * so the heavy native module loads only on the paths that read or write Parquet through DuckDB.
 */
export async function connectDuckDB(): Promise<import("@duckdb/node-api").DuckDBConnection> {
	const { DuckDBInstance } = await import("@duckdb/node-api")
	const instance = await DuckDBInstance.create()

	return await instance.connect()
}

/**
 * Snappy is the codec selected for corpus slices.
 */
export const SLICE_COMPRESSION = "SNAPPY" as const

export interface ParquetFieldDefinition {
	// oxlint-disable-next-line unicorn/text-encoding-identifier-case -- Parquet logical type name.
	type: "UTF8" | "INT32"
	compression: typeof SLICE_COMPRESSION
	repeated?: boolean
	optional?: boolean
}

export type ParquetSchemaDefinition<T> = Record<Extract<keyof T, string>, ParquetFieldDefinition>

/**
 * A single Parquet row shape. The index signature allows callers to carry source fields before projection.
 *
 * Optional fields are represented as null in the Arrow table and read back as null.
 */
export interface ParquetRow {
	raw: string
	tokens: readonly string[]
	labels: readonly string[]
	span_starts: readonly number[]
	span_ends: readonly number[]
	span_tags: readonly string[]
	country: string
	locale?: string | null
	source: string
	source_id: string
	corpus_version: string
	license: string
	synth_method?: string | null
	synth_base_id?: string | null
	[key: string]: unknown
}

/**
 * Column names emitted into every slice. Matches `ParquetRow`.
 */
export const PARQUET_COLUMNS = [
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

/* oxlint-disable unicorn/text-encoding-identifier-case -- `"UTF8"` below is a ParquetType enum member,
   not a text-encoding identifier. Lowercasing it does not type-check against ParquetSchemaDefinition,
   and the rule has no way to tell the two apart. */

/**
 * Parquet schema for `LabeledRow` per #18 §4. Optional fields use `optional: true`; repeated UTF8 columns capture
 * tokens/labels arrays. Compression is per-column SNAPPY.
 */
export const LABELED_ROW_SCHEMA: ParquetSchemaDefinition<ParquetRow> = {
	raw: { type: "UTF8", compression: SLICE_COMPRESSION },
	tokens: { type: "UTF8", repeated: true, compression: SLICE_COMPRESSION },
	labels: { type: "UTF8", repeated: true, compression: SLICE_COMPRESSION },
	// v0.5.0 char-offset label spans (#519): parallel arrays over `raw` (UTF-16 code units,
	// [start, end) exclusive-end, sorted, non-overlapping). INT32 — raw is a short address string,
	// and INT32 round-trips as `number` where parquetjs INT64 would surface bigint.
	span_starts: { type: "INT32", repeated: true, compression: SLICE_COMPRESSION },
	span_ends: { type: "INT32", repeated: true, compression: SLICE_COMPRESSION },
	span_tags: { type: "UTF8", repeated: true, compression: SLICE_COMPRESSION },
	country: { type: "UTF8", compression: SLICE_COMPRESSION },
	locale: { type: "UTF8", compression: SLICE_COMPRESSION, optional: true },
	source: { type: "UTF8", compression: SLICE_COMPRESSION },
	source_id: { type: "UTF8", compression: SLICE_COMPRESSION },
	corpus_version: { type: "UTF8", compression: SLICE_COMPRESSION },
	license: { type: "UTF8", compression: SLICE_COMPRESSION },
	synth_method: { type: "UTF8", compression: SLICE_COMPRESSION, optional: true },
	synth_base_id: { type: "UTF8", compression: SLICE_COMPRESSION, optional: true },
}

const stringListType = new List(new Field("item", new Utf8(), true))
const int32ListType = new List(new Field("item", new Int32(), true))

const PARQUET_COLUMN_TYPES: Record<(typeof PARQUET_COLUMNS)[number], string> = {
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

function parquetTable(rows: readonly ParquetRow[]) {
	return new ArrowTable({
		raw: vectorFromArray(
			rows.map((row) => row.raw),
			new Utf8()
		),
		tokens: vectorFromArray(
			rows.map((row) => row.tokens),
			stringListType
		),
		labels: vectorFromArray(
			rows.map((row) => row.labels),
			stringListType
		),
		span_starts: vectorFromArray(
			rows.map((row) => row.span_starts),
			int32ListType
		),
		span_ends: vectorFromArray(
			rows.map((row) => row.span_ends),
			int32ListType
		),
		span_tags: vectorFromArray(
			rows.map((row) => row.span_tags),
			stringListType
		),
		country: vectorFromArray(
			rows.map((row) => row.country),
			new Utf8()
		),
		locale: vectorFromArray(
			rows.map((row) => row.locale ?? null),
			new Utf8()
		),
		source: vectorFromArray(
			rows.map((row) => row.source),
			new Utf8()
		),
		source_id: vectorFromArray(
			rows.map((row) => row.source_id),
			new Utf8()
		),
		corpus_version: vectorFromArray(
			rows.map((row) => row.corpus_version),
			new Utf8()
		),
		license: vectorFromArray(
			rows.map((row) => row.license),
			new Utf8()
		),
		synth_method: vectorFromArray(
			rows.map((row) => row.synth_method ?? null),
			new Utf8()
		),
		synth_base_id: vectorFromArray(
			rows.map((row) => row.synth_base_id ?? null),
			new Utf8()
		),
	})
}

export async function writeParquetRows(rows: readonly ParquetRow[], path: string): Promise<void> {
	const arrow = parquetTable(rows)
	const wasmTable = WasmTable.fromIPCStream(tableToIPC(arrow, "stream"))

	const properties = new WriterPropertiesBuilder()
		.setCompression(Compression.SNAPPY)
		.setCreatedBy("mailwoman")
		.setMaxRowGroupSize(ROW_GROUP_SIZE)
		.build()

	// parquet-wasm serializes key-value metadata through a hash map, whose order is not stable between writes.
	// Slice identity and provenance live in MANIFEST.json, so omitting file metadata preserves deterministic bytes.
	await writeLocalBuffer(writeParquet(wasmTable, properties), path)
}

function normalizeDuckDBValue(value: unknown): unknown {
	if (value && typeof value === "object" && "items" in value && Array.isArray(value.items)) {
		return value.items.map(normalizeDuckDBValue)
	}

	if (value && typeof value === "object" && "toArray" in value && typeof value.toArray === "function") {
		return Array.from(value.toArray() as ArrayLike<unknown>, normalizeDuckDBValue)
	}

	if (Array.isArray(value)) return value.map(normalizeDuckDBValue)

	if (ArrayBuffer.isView(value)) return Array.from(value as unknown as ArrayLike<unknown>, normalizeDuckDBValue)

	return value
}

/**
 * Stream rows from a local Parquet file in DuckDB-managed chunks.
 *
 * DuckDB opens the path itself and exposes its DataChunks through `fetchChunk()`. Rows are converted and yielded one
 * chunk at a time; the complete Parquet file and complete result set are never copied into JavaScript memory.
 */
export async function* streamParquetRows<T>(
	path: string,
	columns?: readonly string[],
	options?: { limit?: number }
): AsyncGenerator<T> {
	const db = await connectDuckDB()
	const projection = columns?.length ? columns.map(escapeSQLIdentifier).join(", ") : "*"
	const limit = options?.limit
	const limitClause = limit === undefined ? "" : ` LIMIT ${validateLimit(limit)}`
	const sql = `SELECT ${projection} FROM read_parquet('${escapeSQLString(path)}')${limitClause}`

	try {
		const stream = await db.stream(sql)
		const columnNames = stream.columnNames()

		for (let chunk = await stream.fetchChunk(); chunk && chunk.rowCount > 0; chunk = await stream.fetchChunk()) {
			const rows = chunk.getRowObjects(columnNames) as Record<string, unknown>[]

			for (const row of rows) {
				yield Object.fromEntries(Object.entries(row).map(([key, value]) => [key, normalizeDuckDBValue(value)])) as T
			}
		}
	} catch (error) {
		if (columns && /Binder Error|Referenced column|does not exist/.test(String(error))) {
			const missing =
				String(error).match(/(?:Referenced column|field named) ["']([^"']+)["']/)?.[1] ?? columns.join(", ")

			throw new Error(`Parquet projection requested column absent from the file schema: ${missing}`, {
				cause: error,
			})
		}

		throw error
	} finally {
		db.closeSync()
	}
}

function escapeSQLIdentifier(value: string): string {
	return `"${value.replaceAll('"', '""')}"`
}

function validateLimit(value: number): number {
	if (!Number.isSafeInteger(value) || value < 0)
		throw new Error(`Parquet row limit must be a non-negative integer: ${value}`)

	return value
}

async function writeStagedParquet(stagePath: string, outputPath: string): Promise<void> {
	const db = await connectDuckDB()
	const columns = [...PARQUET_COLUMNS]

	const columnsLiteral =
		"{" + columns.map((column) => `'${column}': '${PARQUET_COLUMN_TYPES[column]}'`).join(", ") + "}"

	const selectList = columns.map(escapeSQLIdentifier).join(", ")

	try {
		await db.run("SET preserve_insertion_order=true")

		await db.run(
			`COPY (SELECT ${selectList} FROM read_json('${escapeSQLString(stagePath)}', ` +
				`columns = ${columnsLiteral}, format = 'newline_delimited')) ` +
				`TO '${escapeSQLString(outputPath)}' (FORMAT PARQUET, COMPRESSION SNAPPY, ROW_GROUP_SIZE ${ROW_GROUP_SIZE})`
		)
	} finally {
		db.closeSync()
	}
}

async function writeStagedRow(stage: WriteStream, row: ParquetRow): Promise<void> {
	if (!stage.write(JSON.stringify(row) + "\n")) {
		await once(stage, "drain")
	}
}

/**
 * Per-slice metadata captured in `MANIFEST.json`.
 */
export interface SliceDescriptor {
	split: SplitName
	path: string
	format: "parquet"
	compression: typeof SLICE_COMPRESSION
	rows: number
	bytes: number
	sha256: string
	first_source_id: string
	last_source_id: string
	/**
	 * The slice's corpus source slug, when the writer knows it. `audit.ts` prefers this over inferring the source from
	 * `first_source_id`'s prefix; `writeSlices` itself writes multi-source slices and leaves it unset.
	 */
	source?: string
}

export interface SliceManifest {
	corpus_version: string
	schema: readonly string[]
	rows_per_slice: number
	row_group_size: number
	slices: SliceDescriptor[]
	counts: Record<SplitName, number>
	total_rows: number
}

export interface WriteSlicesOptions {
	/**
	 * Root output directory; corpus version dir is created beneath.
	 */
	outputDir: PathBuilderLike

	/**
	 * Corpus version stamped onto rows + into the output directory name.
	 */
	corpusVersion: string

	/**
	 * Max rows per `.parquet` slice. Default 1_000_000 per the Phase 1 plan.
	 */
	rowsPerSlice?: number
}

/**
 * Pre-partitioned labeled-row streams, one per split. Callers (`buildCorpus`) decide each row's split inline at align
 * time via `splitForRow` and route rows to the matching stream, eliminating the prior `Map<source_id, SplitName>` O(n)
 * lookup table.
 *
 * Splits with no rows can be omitted (or passed as an empty iterable); `writeSlices` skips them.
 */
export type PerSplitRows = Partial<Record<SplitName, AsyncIterable<LabeledRow>>>

/**
 * Project a labeled row to the Parquet schema.
 *
 * The span triple is REQUIRED here (#519): `alignRow` emits it on every labeled row, so a row arriving without it came
 * from a producer that hasn't migrated — writing it would silently drop the v0.5.0 labels from the slice (the "builders
 * before parquet = silent loss" hazard). Loud failure, naming the row, instead.
 */
export function rowToParquet(row: LabeledRow): ParquetRow {
	const { span_starts, span_ends, span_tags } = row

	if (span_starts === undefined || span_ends === undefined || span_tags === undefined) {
		throw new Error(
			`rowToParquet: row is missing the char-offset span triple (#519) — ` +
				`span_starts=${span_starts !== undefined} span_ends=${span_ends !== undefined} span_tags=${span_tags !== undefined} ` +
				`(source=${row.source}, source_id=${row.source_id}). ` +
				`Every parquet-bound row must carry span_starts/span_ends/span_tags; ` +
				`producers that emit tokens/labels only have not migrated to the v0.5.0 format.`
		)
	}

	if (span_starts.length !== span_ends.length || span_starts.length !== span_tags.length) {
		throw new Error(
			`rowToParquet: span triple arrays are not parallel — ` +
				`starts=${span_starts.length} ends=${span_ends.length} tags=${span_tags.length} ` +
				`(source=${row.source}, source_id=${row.source_id})`
		)
	}

	return {
		raw: row.raw,
		tokens: row.tokens,
		labels: row.labels,
		span_starts,
		span_ends,
		span_tags,
		country: row.country,
		locale: row.locale ?? null,
		source: row.source,
		source_id: row.source_id,
		corpus_version: row.corpus_version,
		license: row.license,
		synth_method: row.synth?.method ?? null,
		synth_base_id: row.synth?.base_source_id ?? null,
	}
}

/**
 * Stream labeled rows into `.parquet` slices, one set of slices per split. Splits are processed sequentially so that
 * only one slice is open at a time. Rows are staged to newline-delimited JSON with backpressure, then DuckDB writes the
 * Parquet file from disk.
 *
 * Callers pass per-split `AsyncIterable<LabeledRow>` (`PerSplitRows`); the prior `splitFor(sourceID)` callback is gone
 * because pre-partitioning at the caller eliminates the O(n) `Map<source_id, SplitName>` it required. See `buildCorpus`
 * for the new wire-up.
 */
export async function writeSlices(perSplit: PerSplitRows, opts: WriteSlicesOptions): Promise<SliceManifest> {
	const rowsPerSlice = opts.rowsPerSlice ?? 1_000_000
	const corpusDir = join(opts.outputDir, `corpus-v${opts.corpusVersion}`)
	await makeDirectories(corpusDir)

	const slices: SliceDescriptor[] = []
	const counts: Record<SplitName, number> = { train: 0, val: 0, test: 0 }
	let totalRows = 0

	for (const split of ["train", "val", "test"] as const) {
		const rows = perSplit[split]

		if (!rows) continue

		await using staging = await temporaryDirectory(`mailwoman-parquet-${split}-`)

		let sliceIndex = 0
		let path = ""
		let stagePath = ""
		let sliceRows = 0
		let stage: WriteStream | null = null
		let firstSourceID = ""
		let lastSourceID = ""

		const openSlice = async (): Promise<void> => {
			const splitDir = join(corpusDir, split)
			await makeDirectories(splitDir)
			path = join(splitDir, `part-${String(sliceIndex).padStart(4, "0")}.parquet`)

			stagePath = staging.resolve(`part-${String(sliceIndex).padStart(4, "0")}.ndjson`)
			stage = staging.use(openWriteStream(stagePath))
			sliceRows = 0
			firstSourceID = ""
			lastSourceID = ""
		}

		const closeSlice = async (): Promise<void> => {
			const activeStage = stage

			if (!activeStage) return

			await new Promise<void>((resolve, reject) => {
				activeStage.end((error?: Error | null) => (error ? reject(error) : resolve()))
			})

			if (sliceRows) {
				await writeStagedParquet(stagePath, path)

				const fileStat = await tryStat(path)
				const sha256 = await sha256File(path)

				slices.push({
					split,
					path,
					format: "parquet",
					compression: SLICE_COMPRESSION,
					rows: sliceRows,
					bytes: fileStat?.size ?? 0,
					sha256,
					first_source_id: firstSourceID,
					last_source_id: lastSourceID,
				})
			}

			stage = null
			sliceRows = 0
		}

		for await (const row of rows) {
			if (!path) {
				await openSlice()
			}

			const pq = rowToParquet(row)

			if (!stage) throw new Error("Parquet slice writer was not opened")
			await writeStagedRow(stage, pq)

			sliceRows++

			if (sliceRows === 1) {
				firstSourceID = row.source_id
			}

			lastSourceID = row.source_id

			counts[split]++

			totalRows++

			if (sliceRows >= rowsPerSlice) {
				await closeSlice()

				sliceIndex++
				path = ""
			}
		}

		await closeSlice()
	}

	slices.sort((a, b) => (a.split === b.split ? a.path.localeCompare(b.path) : a.split.localeCompare(b.split)))

	const manifest: SliceManifest = {
		corpus_version: opts.corpusVersion,
		schema: PARQUET_COLUMNS,
		rows_per_slice: rowsPerSlice,
		row_group_size: ROW_GROUP_SIZE,
		slices,
		counts,
		total_rows: totalRows,
	}

	await writeLocalJSONFile(manifest, corpusDir, "MANIFEST.json")

	return manifest
}
