/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Final output sharder for the corpus pipeline.
 *
 *   Phase 1 (#9) shipped JSONL shards + a Python (PyArrow) converter as the path to binary Parquet —
 *   bridging until the JS toolchain caught up. Phase 1.5 (#18 §4) replaced that with a native JS
 *   writer based on the salvaged `@dsnp/parquetjs` wrapper from isp-nexus (now in
 *   `./parquet-wrapper/`). The build pipeline no longer touches Python at all in its hot path; the
 *   only remaining Python is the one-shot `train_tokenizer.py` SentencePiece step.
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
 *   Each shard caps at `rowsPerShard` (default 1_000_000); within a shard, parquetjs flushes row
 *   groups every `ROW_GROUP_SIZE` (50_000) rows per the issue spec. The MANIFEST captures every
 *   shard's path, row count, byte size, and SHA-256 (computed by re-reading the shard once after
 *   close — cheap relative to writing it).
 */

import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { mkdir, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { ParquetWriter, type ParquetSchemaDefinition } from "./parquet-wrapper/index.js"
import type { SplitName } from "./split.js"
import type { LabeledRow } from "./types.js"

/** Row groups flush at this many rows (parquetjs internal cadence within a shard). */
export const ROW_GROUP_SIZE = 50_000

/** Snappy is the only zstd-equivalent codec available in @dsnp/parquetjs 1.7.0. */
export const SHARD_COMPRESSION = "SNAPPY" as const

/**
 * A single Parquet-style row shape. The `[key: string]: unknown` index signature is required for
 * compatibility with `ParquetRecordLike` in the wrapper — parquetjs accepts any string key on
 * rows.
 */
export interface ParquetRow {
	raw: string
	tokens: readonly string[]
	labels: readonly string[]
	country: string
	locale: string | null
	source: string
	source_id: string
	corpus_version: string
	license: string
	synth_method: string | null
	synth_base_id: string | null
	[key: string]: unknown
}

/** Column names emitted into every shard. Matches `ParquetRow`. */
export const PARQUET_COLUMNS = [
	"raw",
	"tokens",
	"labels",
	"country",
	"locale",
	"source",
	"source_id",
	"corpus_version",
	"license",
	"synth_method",
	"synth_base_id",
] as const

/**
 * Parquet schema for `LabeledRow` per #18 §4. Optional fields use `optional: true`; repeated UTF8
 * columns capture tokens/labels arrays. Compression is per-column SNAPPY.
 */
export const LABELED_ROW_SCHEMA: ParquetSchemaDefinition<ParquetRow> = {
	raw: { type: "UTF8", compression: SHARD_COMPRESSION },
	tokens: { type: "UTF8", repeated: true, compression: SHARD_COMPRESSION },
	labels: { type: "UTF8", repeated: true, compression: SHARD_COMPRESSION },
	country: { type: "UTF8", compression: SHARD_COMPRESSION },
	locale: { type: "UTF8", compression: SHARD_COMPRESSION, optional: true },
	source: { type: "UTF8", compression: SHARD_COMPRESSION },
	source_id: { type: "UTF8", compression: SHARD_COMPRESSION },
	corpus_version: { type: "UTF8", compression: SHARD_COMPRESSION },
	license: { type: "UTF8", compression: SHARD_COMPRESSION },
	synth_method: { type: "UTF8", compression: SHARD_COMPRESSION, optional: true },
	synth_base_id: { type: "UTF8", compression: SHARD_COMPRESSION, optional: true },
}

/** Per-shard metadata captured in `MANIFEST.json`. */
export interface ShardDescriptor {
	split: SplitName
	path: string
	format: "parquet"
	compression: typeof SHARD_COMPRESSION
	rows: number
	bytes: number
	sha256: string
	first_source_id: string
	last_source_id: string
}

export interface ShardManifest {
	corpus_version: string
	schema: readonly string[]
	rows_per_shard: number
	row_group_size: number
	shards: ShardDescriptor[]
	counts: Record<SplitName, number>
	total_rows: number
}

export interface WriteShardsOptions {
	/** Root output directory; corpus version dir is created beneath. */
	outputDir: string

	/** Corpus version stamped onto rows + into the output directory name. */
	corpusVersion: string

	/** Max rows per `.parquet` shard. Default 1_000_000 per the Phase 1 plan. */
	rowsPerShard?: number

	/**
	 * Mapping from `source_id` → split. Built by the caller (typically from `splitRows`). Rows whose
	 * `source_id` isn't in the map are sent to the `train` split as a safe default.
	 */
	splitFor(sourceId: string): SplitName
}

/** Project a labeled row to the Parquet schema. */
export function rowToParquet(row: LabeledRow): ParquetRow {
	return {
		raw: row.raw,
		tokens: row.tokens,
		labels: row.labels,
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
 * Project a `ParquetRow` for `appendRow`. parquetjs treats `null` as "skip" for `optional` columns;
 * passing it explicitly is fine, but cleaner to omit so the on-disk Definition Levels match what
 * PyArrow / DuckDB / etc. produce for the same logical row.
 */
function appendShape(row: ParquetRow): Record<string, unknown> {
	const out: Record<string, unknown> = {
		raw: row.raw,
		tokens: row.tokens,
		labels: row.labels,
		country: row.country,
		source: row.source,
		source_id: row.source_id,
		corpus_version: row.corpus_version,
		license: row.license,
	}
	if (row.locale !== null) out.locale = row.locale
	if (row.synth_method !== null) out.synth_method = row.synth_method
	if (row.synth_base_id !== null) out.synth_base_id = row.synth_base_id
	return out
}

/**
 * Stream labeled rows into `.parquet` shards, sharded by split. Returns a manifest enumerating
 * every shard's checksum + row count. The runner is responsible for persisting the manifest.
 */
export async function writeShards(rows: AsyncIterable<LabeledRow>, opts: WriteShardsOptions): Promise<ShardManifest> {
	const rowsPerShard = opts.rowsPerShard ?? 1_000_000
	const corpusDir = join(opts.outputDir, `corpus-v${opts.corpusVersion}`)
	await mkdir(corpusDir, { recursive: true })

	interface OpenShard {
		split: SplitName
		shardIndex: number
		writer: ParquetWriter<ParquetRow>
		path: string
		rows: number
		first_source_id: string
		last_source_id: string
	}

	const open = new Map<SplitName, OpenShard>()
	const shards: ShardDescriptor[] = []
	const counts: Record<SplitName, number> = { train: 0, val: 0, test: 0 }
	let totalRows = 0

	const flushShard = async (s: OpenShard): Promise<void> => {
		await s.writer.close()
		const fileStat = await stat(s.path)
		const sha256 = await hashFile(s.path)
		shards.push({
			split: s.split,
			path: s.path,
			format: "parquet",
			compression: SHARD_COMPRESSION,
			rows: s.rows,
			bytes: fileStat.size,
			sha256,
			first_source_id: s.first_source_id,
			last_source_id: s.last_source_id,
		})
	}

	const openShard = async (split: SplitName, shardIndex: number): Promise<OpenShard> => {
		const splitDir = join(corpusDir, split)
		await mkdir(splitDir, { recursive: true })
		const path = join(splitDir, `part-${String(shardIndex).padStart(4, "0")}.parquet`)
		const writer = await ParquetWriter.openFile<ParquetRow>(LABELED_ROW_SCHEMA, path, {
			rowGroupSize: ROW_GROUP_SIZE,
		})
		writer.setMetadata("mailwoman.corpus_version", opts.corpusVersion)
		writer.setMetadata("mailwoman.split", split)
		writer.setMetadata("mailwoman.shard_index", String(shardIndex))
		return {
			split,
			shardIndex,
			writer,
			path,
			rows: 0,
			first_source_id: "",
			last_source_id: "",
		}
	}

	for await (const row of rows) {
		const split = opts.splitFor(row.source_id)
		let cur = open.get(split)
		if (!cur) {
			cur = await openShard(split, 0)
			open.set(split, cur)
		}

		const pq = rowToParquet(row)
		await cur.writer.appendRow(appendShape(pq) as unknown as ParquetRow)
		if (cur.rows === 0) cur.first_source_id = row.source_id
		cur.last_source_id = row.source_id
		cur.rows++
		counts[split]++
		totalRows++

		if (cur.rows >= rowsPerShard) {
			await flushShard(cur)
			const next = await openShard(split, cur.shardIndex + 1)
			open.set(split, next)
		}
	}

	for (const cur of open.values()) {
		if (cur.rows > 0) await flushShard(cur)
		else await cur.writer.close()
	}

	shards.sort((a, b) => (a.split === b.split ? a.path.localeCompare(b.path) : a.split.localeCompare(b.split)))

	const manifest: ShardManifest = {
		corpus_version: opts.corpusVersion,
		schema: PARQUET_COLUMNS,
		rows_per_shard: rowsPerShard,
		row_group_size: ROW_GROUP_SIZE,
		shards,
		counts,
		total_rows: totalRows,
	}
	await writeFile(join(corpusDir, "MANIFEST.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8")
	return manifest
}

/** Single-pass SHA-256 over the file at `path`. Cheap relative to Parquet write throughput. */
async function hashFile(path: string): Promise<string> {
	const hash = createHash("sha256")
	const stream = createReadStream(path)
	for await (const chunk of stream) hash.update(chunk as Buffer)
	return hash.digest("hex")
}
