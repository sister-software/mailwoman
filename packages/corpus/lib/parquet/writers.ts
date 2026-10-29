/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Writes Parquet files and the manifest that describes their contents.
 *
 *   This module exposes two writers. {@linkcode writeParquetFile} writes one file from rows already in memory.
 *   {@linkcode writeParquetSplits} streams per-split row iterables into one set of files per source, as many as the
 *   row cap requires. It returns the manifest. Both writers create their parent directory and write a record beside
 *   every file (`#parquet/record`).
 *
 *   Layout under `<outputDir>`:
 *
 *   ```
 *   corpus-v<version>/
 *     MANIFEST.json
 *   store/
 *     <source>/
 *       <derivation hash>/
 *         data.parquet
 *         data.RECORD.json
 *   ```
 *
 *   A file holds the rows of one source in one split. Its directory is named by its derivation hash, over that
 *   source's extract hash and code hash, the build config with the file's source, split and part, and the builder
 *   version, so two builds that would write different bytes never share a path. The manifest names each
 *   file's split, which is how the per-split routing survives without a split directory.
 *
 *   Each file caps at `rowsPerFile` (default 1,000,000). Within a file DuckDB writes a row group every
 *   {@linkcode ROW_GROUP_SIZE} rows. The manifest captures every file's path, source, row count, byte size and
 *   SHA-256, the digest computed by re-reading the file once after close — cheap against the cost of writing it.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { pathExists, tryStat } from "@mailwoman/core/fs/readers/stat"
import { openWriteStream, type WriteStream } from "@mailwoman/core/fs/streams"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import {
	makeDirectories,
	movePath,
	removePath,
	removePathIfPresent,
	writeLocalBuffer,
	writeLocalJSONFile,
} from "@mailwoman/core/fs/writers"
import { sha256File } from "@mailwoman/core/hash"
import { stringifyJSON } from "@mailwoman/core/json"
import { once } from "@mailwoman/core/utils/events"
import { Field, Int32, Int64, List, Null, Table as ArrowTable, tableToIPC, Utf8, vectorFromArray } from "apache-arrow"
import { Compression, Table as WasmTable, WriterPropertiesBuilder, writeParquet } from "parquet-wasm"
import { type PathBuilderLike, resolvePathBuilder } from "path-ts"

import { corpusDirectoryName } from "#directory"
import { type DuckDBLimits, escapeSQLIdentifier, escapeSQLString, openDuckDB } from "#parquet/duckdb"
import {
	addToTally,
	type DerivationInputs,
	derivationHash,
	type FileDerivation,
	type ParquetFileRecord,
	readParquetRecord,
	resolveDerivation,
	type SourceLicenseTally,
	writeParquetRecord,
} from "#parquet/record"
import {
	PARQUET_COLUMN_TYPES,
	PARQUET_COLUMNS,
	PARQUET_COMPRESSION,
	type ParquetRow,
	ROW_GROUP_SIZE,
	rowToParquet,
	ROWS_PER_FILE,
} from "#parquet/schema"
import { committedRowLicenses, type RowLicenses } from "#source-register/row-license"
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
		augmentation: vectorFromArray(
			rows.map((row) => row.augmentation ?? null),
			new Utf8()
		),
		base_source_id: vectorFromArray(
			rows.map((row) => row.base_source_id ?? null),
			new Utf8()
		),
	})
}

/**
 * Writes an Arrow table as one SNAPPY parquet file with a row group every {@linkcode ROW_GROUP_SIZE} rows.
 */
async function writeArrowParquet(arrow: ArrowTable, path: PathBuilderLike): Promise<void> {
	const wasmTable = WasmTable.fromIPCStream(tableToIPC(arrow, "stream"))

	const properties = new WriterPropertiesBuilder()
		.setCompression(Compression.SNAPPY)
		.setCreatedBy("mailwoman")
		.setMaxRowGroupSize(ROW_GROUP_SIZE)
		.build()

	// parquet-wasm serializes key-value metadata through a hash map.
	// Its order can change between writes.
	// File identity and provenance live in manifest.json, so omitting file
	// metadata preserves deterministic bytes.
	await writeLocalBuffer(writeParquet(wasmTable, properties), path)
}

/**
 * The logical type of one column {@linkcode writeColumnParquetFile} writes.
 */
export const ParquetColumnKind = {
	String: "string",
	StringList: "string[]",
	Int32List: "int32[]",
	Int64List: "int64[]",
	/**
	 * A column whose every value is null, the type pyarrow infers for one.
	 */
	Null: "null",
} as const

export type ParquetColumnKind = (typeof ParquetColumnKind)[keyof typeof ParquetColumnKind]

/**
 * A file's columns in file order, each with its logical type.
 */
export type ParquetColumns = ReadonlyArray<readonly [name: string, kind: ParquetColumnKind]>

const int64ListType = new List(new Field("item", new Int64(), true))

function columnVector(values: unknown[], kind: ParquetColumnKind) {
	switch (kind) {
		case ParquetColumnKind.String:
			return vectorFromArray(values as Array<string | null>, new Utf8())
		case ParquetColumnKind.StringList:
			return vectorFromArray(values as Array<string[] | null>, stringListType)
		case ParquetColumnKind.Int32List:
			return vectorFromArray(values as Array<number[] | null>, int32ListType)
		case ParquetColumnKind.Int64List:
			return vectorFromArray(
				values.map((list) => (list == null ? null : (list as number[]).map((value) => BigInt(value)))),
				int64ListType
			)
		case ParquetColumnKind.Null:
			if (values.some((value) => value != null)) throw new Error("a null column holds a value")

			return vectorFromArray(values as null[], new Null())
	}
}

/**
 * Writes rows held in memory as one parquet file with exactly `columns`, in their order.
 *
 * It is the writer for an output whose schema is fixed by an earlier writer
 * rather than by {@linkcode LABELED_ROW_SCHEMA}, such as a CJK corpus.
 * A row missing a column writes `null` there.
 *
 * It stamps no license and writes no record.
 * The caller stamps each row first.
 */
export async function writeColumnParquetFile(
	rows: readonly object[],
	columns: ParquetColumns,
	path: PathBuilderLike
): Promise<void> {
	const vectors = Object.fromEntries(
		columns.map(([name, kind]) => [
			name,
			columnVector(
				rows.map((row) => (row as Readonly<Record<string, unknown>>)[name] ?? null),
				kind
			),
		])
	)

	await writeArrowParquet(new ArrowTable(vectors), path)
}

/**
 * Replace a row's `license` with its source's register license id, counting the statement it replaced.
 *
 * Every parquet writer calls it before a row reaches a file, so the column holds an SPDX
 * or `LicenseRef-*` id and the producer's prose moves to the file's record.
 *
 * @throws When the row's source has no license id, so no row is written with a placeholder.
 */
export function stampRowLicense(
	row: ParquetRow,
	licenses: RowLicenses,
	statements: Map<string, number>,
	context: string
): ParquetRow {
	const id = licenses.require(row.source, context)

	if (typeof row.license === "string" && row.license && row.license !== id) {
		statements.set(row.license, (statements.get(row.license) ?? 0) + 1)
	}

	return { ...row, license: id }
}

/**
 * Options for {@linkcode writeParquetFile}.
 */
export interface WriteParquetFileOptions {
	/**
	 * @defaultValue {@linkcode committedRowLicenses}
	 */
	licenses?: RowLicenses
}

/**
 * Write one parquet file from rows held in memory, and its record beside it.
 *
 * Each row's `license` is replaced with its source's register license id.
 * {@linkcode stampRowLicense} does the replacement.
 *
 * @throws When the rows hold more than one source, because a record describes a file of one source.
 * @throws When the source has no license id.
 */
export async function writeParquetFile(
	input: readonly ParquetRow[],
	path: PathBuilderLike,
	derivation: FileDerivation,
	options: WriteParquetFileOptions = {}
): Promise<ParquetFileRecord> {
	const sources = new Set(input.map((row) => row.source))

	if (sources.size !== 1) {
		throw new Error(
			`writeParquetFile: ${path.toString()} would hold ${sources.size} sources (${[...sources].join(", ")}); ` +
				`each parquet file holds one source.`
		)
	}

	const licenses = options.licenses ?? (await committedRowLicenses())
	const statements = new Map<string, number>()
	const context = `writeParquetFile ${path.toString()}`
	const rows = input.map((row) => stampRowLicense(row, licenses, statements, context))
	const tally: SourceLicenseTally = new Map()

	addToTally(tally, rows[0]!.source, rows[0]!.license, rows.length)

	await writeArrowParquet(parquetTable(rows), path)

	return writeParquetRecord({
		path,
		tally,
		statements,
		derivation: await resolveDerivation(derivation),
		builtAt: new Date().toISOString(),
	})
}

/**
 * Per-file metadata captured in `manifest.json`, one entry per `.parquet` file of a split.
 *
 * The writer lists them under `files`.
 * Corpora written earlier list them under a retired key, so every reader goes through
 * `baseManifestFiles` here or `manifest_files` in `corpus_files.py`, which accept each spelling.
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
	 * The file's corpus source slug.
	 *
	 * {@linkcode writeParquetSplits} writes one source per file and always sets it.
	 * A manifest written before it did lists multi-source `part-NNNN.parquet` files
	 * without one, so a reader of an older manifest finds it absent and `audit.ts`
	 * infers the source from `first_source_id`'s prefix.
	 */
	source?: string
	/**
	 * The file's derivation hash, which names its store directory.
	 * Absent from manifests written before the store.
	 */
	derivation_hash?: string
}

export interface ParquetManifest {
	corpus_version: string
	schema: readonly string[]
	rows_per_file: number
	row_group_size: number
	files: ParquetFileDescriptor[]
	counts: Record<SplitName, number>
	total_rows: number
}

export interface WriteParquetSplitsOptions {
	/**
	 * Root output directory.
	 *
	 * The corpus version directory and the `store/` directory are created beneath it.
	 */
	outputDir: PathBuilderLike

	/**
	 * The extract hash, code hash and config of one source's files.
	 *
	 * Each file holds one source's rows, so its derivation covers only that source's inputs and code.
	 * The writer adds the file's source, split, part and row cap to the config.
	 *
	 * Rows hold no corpus version, so the version is not a derivation input.
	 * It calls this once per source.
	 */
	derivationFor: (source: string) => FileDerivation | Promise<FileDerivation>

	/**
	 * Corpus version recorded in the manifest and the output directory name.
	 */
	corpusVersion: string

	/**
	 * @defaultValue {@linkcode committedRowLicenses}
	 */
	licenses?: RowLicenses

	/**
	 * Max rows per `.parquet` file.
	 *
	 * @defaultValue `1,000,000`
	 */
	rowsPerFile?: number

	/**
	 * Continue from the files `<corpusDir>/MANIFEST.json` already records.
	 *
	 * The manifest is rewritten after each finished file.
	 * A descriptor is appended only after its `.parquet` file closes, so each recorded file is complete.
	 *
	 * A resumed run rereads each descriptor's size.
	 * For each split and source it discards the rows the recorded files hold and opens the next part.
	 *
	 * The caller therefore has to supply the same iterables in the same order.
	 * For `buildCorpus` that means the same labeled files and the same shuffle seed.
	 */
	resume?: boolean

	/**
	 * Where the manifest of the files this call writes is kept and, under `resume`, read back.
	 *
	 * A parallel build's source worker keeps its own and the coordinator assembles
	 * the corpus manifest from them.
	 *
	 * @defaultValue `<corpusDir>/MANIFEST.json`
	 */
	manifestPath?: PathBuilderLike

	/**
	 * Limits for the DuckDB instance that converts each staged part.
	 *
	 * @defaultValue {@linkcode openDuckDB}'s defaults
	 */
	duckdb?: DuckDBLimits

	/**
	 * Converts one staged NDJSON part to the parquet file at `outputPath`.
	 *
	 * It exists for tests and for callers that wrap the conversion, such as to
	 * observe each part or to fail one.
	 * A wrapper calls {@linkcode writeStagedParquet} to perform the conversion itself.
	 *
	 * @defaultValue {@linkcode writeStagedParquet}
	 */
	convertStagedPart?: (stagePath: string, outputPath: string, limits?: DuckDBLimits) => Promise<void>
}

/**
 * The manifest that a set of finished files describes.
 *
 * `counts` and `total_rows` are summed from the descriptors rather than from a running row counter,
 * so a manifest written between two files never claims the rows of the file being written.
 * Files are listed by split, then path, so the order does not depend on which file finished first.
 */
export function parquetManifestOf(
	files: readonly ParquetFileDescriptor[],
	opts: { corpusVersion: string; rowsPerFile: number }
): ParquetManifest {
	const counts: Record<SplitName, number> = { train: 0, val: 0, test: 0 }
	let totalRows = 0

	for (const file of files) {
		counts[file.split] += file.rows
		totalRows += file.rows
	}

	return {
		corpus_version: opts.corpusVersion,
		schema: PARQUET_COLUMNS,
		rows_per_file: opts.rowsPerFile,
		row_group_size: ROW_GROUP_SIZE,
		files: files.toSorted((a, b) =>
			a.split === b.split ? a.path.localeCompare(b.path) : a.split.localeCompare(b.split)
		),
		counts,
		total_rows: totalRows,
	}
}

/**
 * Pre-partitioned labeled-row streams, one per split.
 *
 * Callers (`buildCorpus`) decide each row's split inline at align time via `splitForRow`
 * and route rows to the matching stream.
 * Splits with no rows can be omitted or passed as an empty iterable.
 * {@linkcode writeParquetSplits} skips them.
 */
export type PerSplitRows = Partial<Record<SplitName, AsyncIterable<LabeledRow>>>

/**
 * DuckDB threads for converting a staged part, whatever the instance's own limit.
 */
export const CONVERSION_THREADS = 1

/**
 * Convert one staged NDJSON part to a parquet file at `outputPath`.
 *
 * @internal Exported for the test that converts one part under several instance thread limits.
 */
export async function writeStagedParquet(stagePath: string, outputPath: string, limits?: DuckDBLimits): Promise<void> {
	using db = await openDuckDB(limits)
	const columns = [...PARQUET_COLUMNS]

	const columnsLiteral =
		"{" + columns.map((column) => `'${column}': '${PARQUET_COLUMN_TYPES[column]}'`).join(", ") + "}"

	const selectList = columns.map(escapeSQLIdentifier).join(", ")

	await db.run("SET preserve_insertion_order=true")
	// The row-group boundaries of a multi-threaded COPY move between runs: measured 2026-10-20
	// on one 1,000,000-row `ban` part, three conversions each at 2, 4 and 16 threads wrote
	// two different files at every count, and 1 thread wrote one file every time.
	// Rows and their order were the same throughout.
	// One thread makes a file's bytes a function of its rows, on any host and in any worker.
	await db.run(`SET threads=${CONVERSION_THREADS}`)

	await db.run(
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
 * A source id becomes a store directory's name, so it must be one path segment.
 */
const STORE_SOURCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u

/**
 * The file one split's rows of one source are being written to.
 */
interface OpenPart {
	source: string
	part: number
	stagePath: string
	stage: WriteStream
	rows: number
	firstSourceID: string
	lastSourceID: string
	tally: SourceLicenseTally
	statements: Map<string, number>
}

/**
 * Streams labeled rows into `.parquet` files, with one set per split and source.
 *
 * It writes the manifest that describes them, and a record beside every file.
 *
 * Splits are processed sequentially.
 * Within a split one file is open per source, since rows arrive interleaved
 * across sources after the shuffle.
 *
 * Rows are staged to newline-delimited JSON with backpressure, then DuckDB
 * writes the Parquet file from disk.
 * A staged part is removed as soon as its conversion succeeds, so the split's staging
 * directory holds only the parts still open, at most one per source.
 *
 * Each source's final part stays open until the split's rows end.
 * Peak disk demand is therefore the unfinished staged parts, plus the conversion
 * output being written, plus DuckDB's spill during that conversion.
 *
 * A failed conversion records no file and adds no manifest entry, so a resumed run writes that part again.
 * The writer keeps the staged part on failure and removes its own partial output.
 *
 * The error states the source, part, row count, source-id range and staged path.
 * The staged part goes when the split's staging directory is disposed.
 * Its rows can be regenerated from the deterministic input.
 *
 * Each conversion writes `data.parquet.partial.<pid>.<random>` and renames it into place,
 * so two writers of one derivation never write the same file.
 *
 * A file whose store path already holds a file is kept when the two sha256 values agree,
 * since the path names its derivation and the bytes are the same.
 * A disagreement throws, because one derivation wrote two different files.
 */
export async function writeParquetSplits(
	perSplit: PerSplitRows,
	opts: WriteParquetSplitsOptions
): Promise<ParquetManifest> {
	const rowsPerFile = opts.rowsPerFile ?? ROWS_PER_FILE
	const corpusDir = resolvePathBuilder(opts.outputDir, corpusDirectoryName(opts.corpusVersion))
	const storeDir = resolvePathBuilder(opts.outputDir, "store")
	await makeDirectories(corpusDir, storeDir)

	const manifestPath = opts.manifestPath ?? corpusDir("MANIFEST.json")
	const licenses = opts.licenses ?? (await committedRowLicenses())
	const files: ParquetFileDescriptor[] = opts.resume ? await readFinishedParquetFiles(manifestPath) : []
	const derivations = new Map<string, Promise<DerivationInputs>>()

	const sourceDerivation = (source: string): Promise<DerivationInputs> => {
		let derivation = derivations.get(source)

		if (!derivation) {
			derivation = Promise.resolve(opts.derivationFor(source)).then(resolveDerivation)
			derivations.set(source, derivation)
		}

		return derivation
	}

	const builtAt = new Date().toISOString()

	const manifestNow = (): ParquetManifest =>
		parquetManifestOf(files, { corpusVersion: opts.corpusVersion, rowsPerFile })

	for (const split of ["train", "val", "test"] as const) {
		const rows = perSplit[split]

		if (!rows) continue

		await using staging = await temporaryDirectory(`mailwoman-parquet-${split}-`)

		// The rows of each source already in this split's `.parquet` files.
		// A resumed run reads the same iterable from its start, so a source's rows arrive again
		// in the same order and the first of them are discarded rather than written twice.
		const skipRows = new Map<string, number>()
		const nextPart = new Map<string, number>()

		for (const file of files) {
			if (file.split !== split || !file.source) continue

			skipRows.set(file.source, (skipRows.get(file.source) ?? 0) + file.rows)
			nextPart.set(file.source, (nextPart.get(file.source) ?? 0) + 1)
		}

		const open = new Map<string, OpenPart>()

		const openPart = (source: string): OpenPart => {
			if (!STORE_SOURCE_PATTERN.test(source)) {
				throw new Error(`writeParquetSplits: source ${stringifyJSON(source)} cannot name a store directory`)
			}

			const part = nextPart.get(source) ?? 0

			nextPart.set(source, part + 1)

			// A string, because DuckDB reads it inside SQL text.
			const stagePath = staging.path(`${source}-${part}.ndjson`).toString()

			const opened: OpenPart = {
				source,
				part,
				stagePath,
				stage: staging.use(openWriteStream(stagePath)),
				rows: 0,
				firstSourceID: "",
				lastSourceID: "",
				tally: new Map(),
				statements: new Map(),
			}

			open.set(source, opened)

			return opened
		}

		const closePart = async (opened: OpenPart): Promise<void> => {
			open.delete(opened.source)

			await new Promise<void>((resolve, reject) => {
				opened.stage.end((error?: Error | null) => (error ? reject(error) : resolve()))
			})

			if (!opened.rows) {
				await removePath(opened.stagePath)

				return
			}

			const derivation = await sourceDerivation(opened.source)

			const fileDerivation = {
				...derivation,
				config: {
					...(derivation.config as Record<string, unknown>),
					rowsPerFile,
					source: opened.source,
					// The sources whose rows this file read.
					// A file holds one source and reads only it.
					inputSources: [opened.source],
					split,
					part: opened.part,
				},
			}

			const hash = derivationHash(fileDerivation)
			const fileDir = storeDir(opened.source, hash)
			// A string, because the manifest records it.
			const path = fileDir("data.parquet").toString()
			// Named for this writer, so two builds converting the same derivation never write one file.
			const pending = fileDir(`data.parquet.partial.${process.pid}.${crypto.randomUUID().slice(0, 8)}`).toString()

			await makeDirectories(fileDir)

			try {
				await (opts.convertStagedPart ?? writeStagedParquet)(opened.stagePath, pending, opts.duckdb)
			} catch (error) {
				await removePathIfPresent(pending)

				throw new Error(
					`writeParquetSplits: converting ${split} part ${opened.part} of ${opened.source} ` +
						`(${opened.rows.toLocaleString()} rows, source_id ${opened.firstSourceID} to ${opened.lastSourceID}) ` +
						`from ${opened.stagePath} to ${pending} failed. No file was recorded for this part.`,
					{ cause: error }
				)
			}

			// The converter's connection closed when `writeStagedParquet` returned,
			// so no reader holds the staged part open.
			// Removing it here bounds staging to the parts still open.
			await removePath(opened.stagePath)

			const sha256 = await sha256File(pending)
			const existing = await tryStat(path)

			if (existing) {
				const kept = await sha256File(path)

				if (kept !== sha256) {
					throw new Error(
						`writeParquetSplits: ${path} holds sha256 ${kept} and this build wrote ${sha256} under the same ` +
							`derivation hash. A derivation input is missing from the hash, or the writer is not deterministic.`
					)
				}

				await removePath(pending)
			} else {
				await movePath(pending, path)
			}

			const record: ParquetFileRecord =
				(existing ? await readParquetRecord(path) : null) ??
				(await writeParquetRecord({
					path,
					tally: opened.tally,
					statements: opened.statements,
					derivation: fileDerivation,
					builtAt,
				}))

			files.push({
				split,
				path,
				format: "parquet",
				compression: PARQUET_COMPRESSION,
				rows: opened.rows,
				bytes: (await tryStat(path))?.size ?? 0,
				sha256: record.sha256,
				first_source_id: opened.firstSourceID,
				last_source_id: opened.lastSourceID,
				source: opened.source,
				derivation_hash: hash,
			})

			// Written per file rather than once at the end, so an interrupted build resumes
			// at each source's next part instead of rewriting every split.
			await writeLocalJSONFile(manifestNow(), manifestPath)
		}

		for await (const row of rows) {
			const skip = skipRows.get(row.source) ?? 0

			if (skip > 0) {
				skipRows.set(row.source, skip - 1)

				continue
			}

			const opened = open.get(row.source) ?? openPart(row.source)
			const pq = stampRowLicense(rowToParquet(row), licenses, opened.statements, "writeParquetSplits")

			await writeStagedRow(opened.stage, pq)

			opened.rows++

			if (opened.rows === 1) {
				opened.firstSourceID = row.source_id
			}

			opened.lastSourceID = row.source_id
			addToTally(opened.tally, row.source, pq.license, 1)

			if (opened.rows >= rowsPerFile) {
				await closePart(opened)
			}
		}

		// `closePart` deletes the entry being visited, which a Map iterator permits.
		for (const opened of open.values()) {
			await closePart(opened)
		}
	}

	const manifest = manifestNow()

	await writeLocalJSONFile(manifest, manifestPath)

	return manifest
}

/**
 * The finished `.parquet` files an earlier run recorded, each verified against its file on disk.
 *
 * @throws When a recorded file names no source, is missing, or its size differs from the descriptor.
 * The writer creates a descriptor only after closing the file.
 * Either case therefore means the file changed after its run.
 * The writer would produce a corpus whose manifest describes bytes the files
 * no longer contain if it continued.
 */
async function readFinishedParquetFiles(manifestPath: PathBuilderLike): Promise<ParquetFileDescriptor[]> {
	if (!(await pathExists(manifestPath))) return []

	const manifest = await readLocalJSONFile<ParquetManifest>(manifestPath)

	for (const file of manifest.files) {
		if (!file.source) {
			throw new Error(
				`resume refused: ${manifestPath.toString()} records ${file.path} with no source, so it was written ` +
					`before files held one source each. Delete the manifest to write every parquet file again.`
			)
		}

		const stat = await tryStat(file.path)

		if (!stat) {
			throw new Error(
				`resume refused: ${manifestPath.toString()} records ${file.path} and no file sits at that path. ` +
					`Delete the manifest to write every parquet file again.`
			)
		}

		if (stat.size !== file.bytes) {
			throw new Error(
				`resume refused: ${file.path} is ${stat.size.toLocaleString()} bytes and ` +
					`${manifestPath.toString()} records ${file.bytes.toLocaleString()}.`
			)
		}
	}

	return [...manifest.files]
}
