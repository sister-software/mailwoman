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
 *   Compression: `SNAPPY`. The plan in #18 §4 specified `zstd`, but `@dsnp/parquetjs` 1.7.0 only
 *   supports UNCOMPRESSED / GZIP / SNAPPY / BROTLI (see `node_modules/@dsnp/parquetjs/dist/lib/
 *   compression.js`). SNAPPY is the standard ML-corpus default (PyArrow's default too) and is the
 *   closest substitute on speed; revisit if @dsnp/parquetjs gains zstd support. Documented in
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
 *   Each slice caps at `rowsPerSlice` (default 1_000_000); within a slice, parquetjs flushes row
 *   groups every `ROW_GROUP_SIZE` (50_000) rows per the issue spec. The MANIFEST captures every
 *   slice's path, row count, byte size, and SHA-256 (computed by re-reading the slice once after
 *   close — cheap relative to writing it).
 */

import { tryStat } from "@mailwoman/core/fs/readers"
import { writeLocalJSONFile, makeDirectories } from "@mailwoman/core/fs/writers"
import { sha256File } from "@mailwoman/core/hash"
import { join, type PathBuilderLike } from "path-ts"

import { ParquetWriter, type ParquetSchemaDefinition } from "#parquet-wrapper"
import type { LabeledRow } from "#types"
import type { SplitName } from "#utils/split"

/**
 * Row groups flush at this many rows (parquetjs internal cadence within a slice).
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
 * Snappy is the only zstd-equivalent codec available in @dsnp/parquetjs 1.7.0.
 */
export const SLICE_COMPRESSION = "SNAPPY" as const

/**
 * A single Parquet-style row shape. The `[key: string]: unknown` index signature is required for compatibility with
 * `ParquetRecordLike` in the wrapper — parquetjs accepts any string key on rows.
 *
 * The three columns the schema marks `optional: true` are optional here too: `appendRow` receives the row with them
 * OMITTED rather than null (see {@link appendShape}), and a reader gets back whichever of null/absent parquetjs
 * surfaces.
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
 * Project a `ParquetRow` for `appendRow`. parquetjs treats `null` as "skip" for `optional` columns; passing it
 * explicitly is fine, but cleaner to omit so the on-disk Definition Levels match what PyArrow / DuckDB / etc. produce
 * for the same logical row.
 *
 * EXPORTED because it was not, and a second producer hand-rolled its own copy that predates the v0.5.0 span triple
 * (#519). `LABELED_ROW_SCHEMA` declares those three columns `repeated` and NOT optional, so the copy wrote empty arrays
 * under a schema promising values. Every new column has to arrive here once, not once per writer.
 */
export function appendShape(row: ParquetRow): ParquetRow {
	const out: ParquetRow = {
		raw: row.raw,
		tokens: row.tokens,
		labels: row.labels,
		span_starts: row.span_starts,
		span_ends: row.span_ends,
		span_tags: row.span_tags,
		country: row.country,
		source: row.source,
		source_id: row.source_id,
		corpus_version: row.corpus_version,
		license: row.license,
	}

	if (row.locale !== null) {
		out.locale = row.locale
	}

	if (row.synth_method !== null) {
		out.synth_method = row.synth_method
	}

	if (row.synth_base_id !== null) {
		out.synth_base_id = row.synth_base_id
	}

	return out
}

/**
 * Stream labeled rows into `.parquet` slices, one set of slices per split. Splits are processed sequentially so that
 * only one slice writer is open at a time — memory cost is bounded by the parquetjs row-group buffer (~`ROW_GROUP_SIZE
 * × row_size`), not by the labeled-row count.
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

		let sliceIndex = 0
		let writer: ParquetWriter<ParquetRow> | null = null
		let path = ""
		let sliceRows = 0
		let firstSourceID = ""
		let lastSourceID = ""

		const openSlice = async (): Promise<void> => {
			const splitDir = join(corpusDir, split)
			await makeDirectories(splitDir)
			path = join(splitDir, `part-${String(sliceIndex).padStart(4, "0")}.parquet`)

			writer = await ParquetWriter.openFile<ParquetRow>(LABELED_ROW_SCHEMA, path, {
				rowGroupSize: ROW_GROUP_SIZE,
			})

			writer.setMetadata("mailwoman.corpus_version", opts.corpusVersion)
			writer.setMetadata("mailwoman.split", split)
			writer.setMetadata("mailwoman.slice_index", String(sliceIndex))
			sliceRows = 0
			firstSourceID = ""
			lastSourceID = ""
		}

		const closeSlice = async (): Promise<void> => {
			if (!writer) return
			await writer[Symbol.asyncDispose]()

			if (sliceRows > 0) {
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

			writer = null
		}

		for await (const row of rows) {
			if (!writer) {
				await openSlice()
			}

			const pq = rowToParquet(row)
			await writer!.appendRow(appendShape(pq))

			if (sliceRows === 0) {
				firstSourceID = row.source_id
			}

			lastSourceID = row.source_id

			sliceRows++

			counts[split]++

			totalRows++

			if (sliceRows >= rowsPerSlice) {
				await closeSlice()

				sliceIndex++
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
