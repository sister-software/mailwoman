/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Final output sharder for the corpus pipeline (Phase 1 task #7 in the plan).
 *
 *   The plan allows two output paths:
 *
 *   1. `@dsnp/parquetjs` — native JS Parquet writer.
 *   2. JSONL shards + a tiny Python (PyArrow) converter.
 *
 *   This module ships path #2: it streams `LabeledRow`s into 1M-row JSONL shards under
 *   `<outputDir>/corpus-v<version>/<split>/part-NNNN.jsonl` with a per-shard SHA-256, and writes a
 *   `MANIFEST.json` capturing the schema, every shard's checksum + counts, and the corpus version.
 *   The companion Python script `packages/corpus-python/scripts/jsonl_to_parquet.py` reads these
 *   shards and writes real Parquet via PyArrow (driven by the operator when binary Parquet is
 *   required for the training loop).
 *
 *   Rationale for shipping JSONL first:
 *
 *   - Reviewable in the corpus build pipeline (line-oriented).
 *   - No native binary dep on the JS side (parquetjs has had ARM64 + list-column issues historically).
 *   - Final binary format is trivial to swap in via the Python converter or a future `parquetjs`-based
 *       writer; the schema + checksum manifest is unchanged.
 *
 *   Layout under `<outputDir>`:
 *
 *   ```
 *   corpus-v<version>/
 *   MANIFEST.json
 *   train/
 *     part-0000.jsonl
 *     part-0001.jsonl
 *     ...
 *   val/
 *     part-0000.jsonl
 *   test/
 *     part-0000.jsonl
 * ```
 */

import { createWriteStream, type WriteStream } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { streamingSha256, type StreamingHasher } from "./adapter.js"
import type { SplitName } from "./split.js"
import type { LabeledRow } from "./types.js"

/** A single Parquet-style row shape. Same fields the Python converter expects. */
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

/** Per-shard metadata captured in `MANIFEST.json`. */
export interface ShardDescriptor {
	split: SplitName
	path: string
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
	shards: ShardDescriptor[]
	counts: Record<SplitName, number>
	total_rows: number
}

export interface WriteShardsOptions {
	/** Root output directory; corpus version dir is created beneath. */
	outputDir: string

	/** Corpus version stamped onto rows + into the output directory name. */
	corpusVersion: string

	/** Max rows per JSONL shard. Default 1_000_000 per the Phase 1 plan. */
	rowsPerShard?: number

	/**
	 * Mapping from `source_id` → split. Built by the caller (typically from `splitRows`). Rows whose
	 * `source_id` isn't in the map are sent to the `train` split as a safe default. The
	 * unsplit-default behavior is logged in the manifest.
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
 * Stream labeled rows into JSONL shards, sharded by split. Returns a manifest enumerating every
 * shard's checksum + row count. The runner is responsible for persisting the manifest (it's just
 * JSON-serializable).
 */
export async function writeShards(rows: AsyncIterable<LabeledRow>, opts: WriteShardsOptions): Promise<ShardManifest> {
	const rowsPerShard = opts.rowsPerShard ?? 1_000_000
	const corpusDir = join(opts.outputDir, `corpus-v${opts.corpusVersion}`)
	await mkdir(corpusDir, { recursive: true })

	interface OpenShard {
		split: SplitName
		shardIndex: number
		stream: WriteStream
		hasher: StreamingHasher
		path: string
		rows: number
		bytes: number
		first_source_id: string
		last_source_id: string
	}

	const open = new Map<SplitName, OpenShard>()
	const shards: ShardDescriptor[] = []
	const counts: Record<SplitName, number> = { train: 0, val: 0, test: 0 }
	let totalRows = 0

	const flushShard = async (s: OpenShard): Promise<void> => {
		s.stream.end()
		await once(s.stream, "close")
		shards.push({
			split: s.split,
			path: s.path,
			rows: s.rows,
			bytes: s.bytes,
			sha256: s.hasher.digest(),
			first_source_id: s.first_source_id,
			last_source_id: s.last_source_id,
		})
	}

	const openShard = async (split: SplitName, shardIndex: number): Promise<OpenShard> => {
		const splitDir = join(corpusDir, split)
		await mkdir(splitDir, { recursive: true })
		const path = join(splitDir, `part-${String(shardIndex).padStart(4, "0")}.jsonl`)
		const stream = createWriteStream(path, { encoding: "utf8" })
		return {
			split,
			shardIndex,
			stream,
			hasher: streamingSha256(),
			path,
			rows: 0,
			bytes: 0,
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

		const line = `${JSON.stringify(rowToParquet(row))}\n`
		if (!cur.stream.write(line)) await once(cur.stream, "drain")
		cur.hasher.update(line)
		cur.bytes += Buffer.byteLength(line, "utf8")
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
		else {
			cur.stream.end()
			await once(cur.stream, "close")
		}
	}

	shards.sort((a, b) => (a.split === b.split ? a.path.localeCompare(b.path) : a.split.localeCompare(b.split)))

	const manifest: ShardManifest = {
		corpus_version: opts.corpusVersion,
		schema: PARQUET_COLUMNS,
		rows_per_shard: rowsPerShard,
		shards,
		counts,
		total_rows: totalRows,
	}
	await writeFile(join(corpusDir, "MANIFEST.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8")
	return manifest
}

function once(emitter: WriteStream, event: "drain" | "close"): Promise<void> {
	return new Promise((resolve, reject) => {
		const onEvent = (): void => {
			emitter.off("error", onError)
			resolve()
		}
		const onError = (err: Error): void => {
			emitter.off(event, onEvent)
			reject(err)
		}
		emitter.once(event, onEvent)
		emitter.once("error", onError)
	})
}
