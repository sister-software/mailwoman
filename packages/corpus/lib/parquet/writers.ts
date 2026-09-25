/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Parquet writing, and the manifest that describes what was written.
 *
 *   Two writers, and the names say which is which. {@linkcode writeParquetFile} writes a single file from rows already
 *   in memory. {@linkcode writeParquetSplits} streams per-split row iterables into as many files as the row cap needs,
 *   and answers the manifest. Both create their parent directory, the same ceremony `@mailwoman/core/fs`'s writers
 *   encode rather than repeat at each call site.
 *
 *   Layout under `<outputDir>`:
 *
 *   ```
 *   corpus-v<version>/
 *     manifest.json
 *     train/
 *       part-0000.parquet
 *       part-0001.parquet
 *     val/
 *       part-0000.parquet
 *     test/
 *       part-0000.parquet
 *   ```
 *
 *   Each file caps at `rowsPerFile` (default 1,000,000). Within a file DuckDB writes a row group every
 *   {@linkcode ROW_GROUP_SIZE} rows. The manifest captures every file's path, row count, byte size and SHA-256, the
 *   digest computed by re-reading the file once after close — cheap against the cost of writing it.
 *
 *   A part is closed by its row count and never by a source boundary, so one part may hold the tail of one source and
 *   the head of the next. A reader must therefore take a file's sources from all of its rows: the training loader's
 *   `_index_by_source` once read the first row's source as the whole file's, and two sources that opened no file of
 *   their own trained at another source's weight (#2318).
 */

import { tryStat } from "@mailwoman/core/fs/readers"
import { openWriteStream, type WriteStream } from "@mailwoman/core/fs/streams"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { makeDirectories, writeLocalBuffer, writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { sha256File } from "@mailwoman/core/hash"
import { stringifyJSON } from "@mailwoman/core/json"
import { once } from "@mailwoman/core/utils/events"
import { Field, Int32, List, Table as ArrowTable, tableToIPC, Utf8, vectorFromArray } from "apache-arrow"
import { Compression, Table as WasmTable, WriterPropertiesBuilder, writeParquet } from "parquet-wasm"
import { type PathBuilderLike, resolvePathBuilder } from "path-ts"

import { escapeSQLIdentifier, escapeSQLString, openDuckDB } from "#parquet/duckdb"
import {
	PARQUET_COLUMN_TYPES,
	PARQUET_COLUMNS,
	PARQUET_COMPRESSION,
	type ParquetRow,
	ROW_GROUP_SIZE,
	rowToParquet,
	ROWS_PER_FILE,
} from "#parquet/schema"
import type { LabeledRow } from "#types"
import type { SplitName } from "#utils/split"

const stringListType = new List(new Field("item", new Utf8(), true))
const int32ListType = new List(new Field("item", new Int32(), true))

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
		register: vectorFromArray(
			rows.map((row) => row.register ?? null),
			new Utf8()
		),
		surface: vectorFromArray(
			rows.map((row) => row.surface),
			new Utf8()
		),
		recipe: vectorFromArray(
			rows.map((row) => row.recipe ?? null),
			new Utf8()
		),
		base_source_id: vectorFromArray(
			rows.map((row) => row.base_source_id ?? null),
			new Utf8()
		),
	})
}

/**
 * Write one parquet file from rows held in memory.
 */
export async function writeParquetFile(rows: readonly ParquetRow[], path: PathBuilderLike): Promise<void> {
	const arrow = parquetTable(rows)
	const wasmTable = WasmTable.fromIPCStream(tableToIPC(arrow, "stream"))

	const properties = new WriterPropertiesBuilder()
		.setCompression(Compression.SNAPPY)
		.setCreatedBy("mailwoman")
		.setMaxRowGroupSize(ROW_GROUP_SIZE)
		.build()

	// parquet-wasm serializes key-value metadata through a hash map, whose order is not stable between writes.
	// File identity and provenance live in manifest.json, so omitting file
	// metadata preserves deterministic bytes.
	await writeLocalBuffer(writeParquet(wasmTable, properties), path)
}

/**
 * Per-file metadata captured in `manifest.json`, one entry per `.parquet` file of a split.
 *
 * The `slices` key it sits under is the wire interface the Python loader reads
 * (`manifest_files` in `corpus_files.py`, with its pre-rename fallback); every corpus
 * on disk carries it, so the key name is not the writer's to change.
 */
export interface ParquetFileDescriptor {
	split: SplitName
	path: string
	format: "parquet"
	compression: typeof PARQUET_COMPRESSION
	rows: number
	bytes: number
	sha256: string
	first_source_id: string
	last_source_id: string
	/**
	 * The file's corpus source slug, when the writer knows it.
	 *
	 * `audit.ts` prefers this over inferring the source from `first_source_id`'s prefix;
	 * {@linkcode writeParquetSplits} itself writes multi-source files and leaves it unset.
	 */
	source?: string
}

export interface ParquetManifest {
	corpus_version: string
	schema: readonly string[]
	rows_per_slice: number
	row_group_size: number
	slices: ParquetFileDescriptor[]
	counts: Record<SplitName, number>
	total_rows: number
}

export interface WriteParquetSplitsOptions {
	/**
	 * Root output directory.
	 *
	 * The corpus version directory is created beneath it.
	 */
	outputDir: PathBuilderLike

	/**
	 * Corpus version stamped onto rows and into the output directory name.
	 */
	corpusVersion: string

	/**
	 * Max rows per `.parquet` file.
	 *
	 * Default 1,000,000 per the Phase 1 plan.
	 */
	rowsPerFile?: number
}

/**
 * Pre-partitioned labeled-row streams, one per split.
 *
 * Callers (`buildCorpus`) decide each row's split inline at align time via `splitForRow` and route
 * rows to the matching stream, eliminating the prior `Map<source_id, SplitName>` O(n) lookup table.
 *
 * Splits with no rows can be omitted (or passed as an empty iterable);
 * {@linkcode writeParquetSplits} skips them.
 */
export type PerSplitRows = Partial<Record<SplitName, AsyncIterable<LabeledRow>>>

async function writeStagedParquet(stagePath: string, outputPath: string): Promise<void> {
	await using db = await openDuckDB()
	const columns = [...PARQUET_COLUMNS]

	const columnsLiteral =
		"{" + columns.map((column) => `'${column}': '${PARQUET_COLUMN_TYPES[column]}'`).join(", ") + "}"

	const selectList = columns.map(escapeSQLIdentifier).join(", ")

	await db.connection.run("SET preserve_insertion_order=true")

	await db.connection.run(
		`COPY (SELECT ${selectList} FROM read_json('${escapeSQLString(stagePath)}', ` +
			`columns = ${columnsLiteral}, format = 'newline_delimited')) ` +
			`TO '${escapeSQLString(outputPath)}' (FORMAT PARQUET, COMPRESSION SNAPPY, ROW_GROUP_SIZE ${ROW_GROUP_SIZE})`
	)
}

async function writeStagedRow(stage: WriteStream, row: ParquetRow): Promise<void> {
	if (!stage.write(stringifyJSON(row) + "\n")) {
		await once(stage, "drain")
	}
}

/**
 * Stream labeled rows into `.parquet` files, one set of files per split,
 * and write the manifest describing them.
 *
 * Splits are processed sequentially so only one file is open at a time.
 * Rows are staged to newline-delimited JSON with backpressure, then DuckDB
 * writes the Parquet file from disk.
 */
export async function writeParquetSplits(
	perSplit: PerSplitRows,
	opts: WriteParquetSplitsOptions
): Promise<ParquetManifest> {
	const rowsPerFile = opts.rowsPerFile ?? ROWS_PER_FILE
	const corpusDir = resolvePathBuilder(opts.outputDir, `corpus-v${opts.corpusVersion}`)
	await makeDirectories(corpusDir)

	const files: ParquetFileDescriptor[] = []
	const counts: Record<SplitName, number> = { train: 0, val: 0, test: 0 }
	let totalRows = 0

	for (const split of ["train", "val", "test"] as const) {
		const rows = perSplit[split]

		if (!rows) continue

		await using staging = await temporaryDirectory(`mailwoman-parquet-${split}-`)

		let fileIndex = 0
		let path = ""
		let stagePath = ""
		let fileRows = 0
		let stage: WriteStream | null = null
		let firstSourceID = ""
		let lastSourceID = ""

		const openFile = async (): Promise<void> => {
			const splitDir = corpusDir(split)
			await makeDirectories(splitDir)
			// A string, because the manifest records it.
			path = splitDir(`part-${String(fileIndex).padStart(4, "0")}.parquet`).toString()

			// A string, because DuckDB reads it inside SQL text.
			stagePath = staging.path(`part-${String(fileIndex).padStart(4, "0")}.ndjson`).toString()
			stage = staging.use(openWriteStream(stagePath))
			fileRows = 0
			firstSourceID = ""
			lastSourceID = ""
		}

		const closeFile = async (): Promise<void> => {
			const activeStage = stage

			if (!activeStage) return

			await new Promise<void>((resolve, reject) => {
				activeStage.end((error?: Error | null) => (error ? reject(error) : resolve()))
			})

			if (fileRows) {
				await writeStagedParquet(stagePath, path)

				const fileStat = await tryStat(path)
				const sha256 = await sha256File(path)

				files.push({
					split,
					path,
					format: "parquet",
					compression: PARQUET_COMPRESSION,
					rows: fileRows,
					bytes: fileStat?.size ?? 0,
					sha256,
					first_source_id: firstSourceID,
					last_source_id: lastSourceID,
				})
			}

			stage = null
			fileRows = 0
		}

		for await (const row of rows) {
			if (!path) {
				await openFile()
			}

			const pq = rowToParquet(row)

			if (!stage) throw new Error("Parquet file writer was not opened")
			await writeStagedRow(stage, pq)

			fileRows++

			if (fileRows === 1) {
				firstSourceID = row.source_id
			}

			lastSourceID = row.source_id

			counts[split]++

			totalRows++

			if (fileRows >= rowsPerFile) {
				await closeFile()

				fileIndex++
				path = ""
			}
		}

		await closeFile()
	}

	files.sort((a, b) => (a.split === b.split ? a.path.localeCompare(b.path) : a.split.localeCompare(b.split)))

	const manifest: ParquetManifest = {
		corpus_version: opts.corpusVersion,
		schema: PARQUET_COLUMNS,
		rows_per_slice: rowsPerFile,
		row_group_size: ROW_GROUP_SIZE,
		slices: files,
		counts,
		total_rows: totalRows,
	}

	await writeLocalJSONFile(manifest, corpusDir("MANIFEST.json"))

	return manifest
}
