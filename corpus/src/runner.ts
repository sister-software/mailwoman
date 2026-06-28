/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Adapter runner — drives a `CorpusAdapter` to completion and writes intermediate JSONL + a
 *   per-shard manifest.
 *
 *   Output layout under `outputDir`:
 *
 *   ```
 *   <outputDir>/<adapter.id>/
 *   canonical.jsonl       # one row per line, in emission order
 *   MANIFEST.json         # adapter id, version, row count, sha256, license, started_at, ended_at
 * ```
 *
 *   The runner is responsible for everything an adapter is **not** responsible for:
 *
 *   - Stamping `corpus_version` on every row (adapters must NOT set it).
 *   - Applying `canonicalDedupKey` and skipping duplicates.
 *   - Streaming sha256 over JSONL bytes so the manifest checksum doesn't require a re-read.
 *   - Honoring backpressure on the output write stream.
 *   - Counting + emitting periodic progress to an optional callback.
 *   - Honoring `signal` (delegates to adapter's iteration boundary).
 *
 *   The runner does NOT perform alignment, tokenization, synthesis, or sharding into Parquet. Those
 *   steps run later, consuming the JSONL shards this writes.
 */

import { createWriteStream, type WriteStream } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import { canonicalDedupKey, streamingSha256, type AdapterRegistry, type StreamingHasher } from "./adapter.js"
import type { AdapterOptions, CanonicalRow, CorpusAdapter } from "./types.js"

/** Snapshot of the runner's state, emitted on every progress tick. */
export interface RunnerProgress {
	/** Adapter being driven. */
	adapterId: string

	/** Total rows the adapter has yielded (before dedup). */
	yielded: number

	/** Rows actually written to JSONL (after dedup). */
	written: number

	/** Bytes written to JSONL so far. */
	bytes: number

	/** Wall-clock milliseconds since the run started. */
	elapsed_ms: number
}

/** Per-invocation options for `runAdapter`. */
export interface RunAdapterOptions {
	/** Adapter to drive. */
	adapter: CorpusAdapter

	/** Options handed to the adapter (input path, country filter, limit, signal). */
	adapterOptions: AdapterOptions

	/** Root output directory; the runner creates `<outputDir>/<adapter.id>/` under it. */
	outputDir: string

	/** Corpus version stamped onto every row. Locked together with the tokenizer version. */
	corpusVersion: string

	/**
	 * Optional progress callback. Invoked every `progressEvery` rows yielded (default 1000) and once at the end of the
	 * run. Errors thrown from this callback abort the run.
	 */
	onProgress?: (snapshot: RunnerProgress) => void

	/**
	 * Yielded-row interval at which `onProgress` fires. Defaults to 1000. The terminal tick is always emitted regardless
	 * of this value.
	 */
	progressEvery?: number
}

/** Return value of `runAdapter`: the same shape as `MANIFEST.json` on disk. */
export interface AdapterRunManifest {
	adapter_id: string
	corpus_version: string
	default_license: string
	description: string
	yielded: number
	written: number
	deduped: number
	bytes: number
	sha256: string
	jsonl_path: string
	started_at: string
	ended_at: string
	elapsed_ms: number
}

/**
 * Drive a single adapter to completion.
 *
 * Returns the manifest describing the run. Writes `canonical.jsonl` + `MANIFEST.json` under `outputDir/<adapter.id>/`.
 * Throws if the output directory cannot be created, if a row arrives with a missing required field, or if the abort
 * signal fires.
 */
export async function runAdapter(opts: RunAdapterOptions): Promise<AdapterRunManifest> {
	const { adapter, adapterOptions, outputDir, corpusVersion } = opts
	const progressEvery = opts.progressEvery ?? 1_000

	const adapterDir = join(outputDir, adapter.id)
	await mkdir(adapterDir, { recursive: true })

	const jsonlPath = join(adapterDir, "canonical.jsonl")
	const manifestPath = join(adapterDir, "MANIFEST.json")

	const startedAt = new Date()
	const t0 = performance.now()

	const stream = createWriteStream(jsonlPath, { encoding: "utf8" })
	const hasher: StreamingHasher = streamingSha256()
	const seen = new Set<string>()
	const DEDUP_MAX_SIZE = 10_000_000
	let dedupExhausted = false

	let yielded = 0
	let written = 0
	let bytes = 0

	const emitProgress = (): void => {
		opts.onProgress?.({
			adapterId: adapter.id,
			yielded,
			written,
			bytes,
			elapsed_ms: performance.now() - t0,
		})
	}

	try {
		for await (const row of adapter.rows(adapterOptions)) {
			if (adapterOptions.signal?.aborted) {
				throw new DOMException("Adapter run aborted by signal", "AbortError")
			}

			yielded++
			assertEmittedRow(adapter, row)

			const stamped: CanonicalRow = { ...row, corpus_version: corpusVersion }
			const key = canonicalDedupKey(stamped)

			if (!dedupExhausted) {
				if (seen.has(key)) {
					if (yielded % progressEvery === 0) emitProgress()
					continue
				}

				if (seen.size >= DEDUP_MAX_SIZE) {
					dedupExhausted = true
					process.stderr.write(
						`  runner: dedup set full at ${DEDUP_MAX_SIZE.toLocaleString()} — skipping dedup for remaining rows\n`
					)
				} else {
					seen.add(key)
				}
			}

			const line = `${JSON.stringify(stamped)}\n`
			hasher.update(line)
			bytes += Buffer.byteLength(line, "utf8")
			written++

			if (!stream.write(line)) {
				await once(stream, "drain")
			}

			if (yielded % progressEvery === 0) emitProgress()
		}
	} finally {
		stream.end()
		await once(stream, "close")
	}

	const endedAt = new Date()
	const elapsed_ms = performance.now() - t0
	emitProgress()

	const manifest: AdapterRunManifest = {
		adapter_id: adapter.id,
		corpus_version: corpusVersion,
		default_license: adapter.defaultLicense,
		description: adapter.description,
		yielded,
		written,
		deduped: yielded - written,
		bytes,
		sha256: hasher.digest(),
		jsonl_path: jsonlPath,
		started_at: startedAt.toISOString(),
		ended_at: endedAt.toISOString(),
		elapsed_ms,
	}

	await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8")

	return manifest
}

/**
 * Drive every adapter in a registry sequentially. Stops on the first failure (caller can filter the registry before
 * calling if partial-failure is desired).
 *
 * Returns the manifests in registry insertion order.
 */
export async function runAllAdapters(
	registry: AdapterRegistry,
	common: Omit<RunAdapterOptions, "adapter"> & { adapterOptionsFor?: (a: CorpusAdapter) => AdapterOptions }
): Promise<AdapterRunManifest[]> {
	const out: AdapterRunManifest[] = []

	for (const adapter of registry.list()) {
		const adapterOptions = common.adapterOptionsFor?.(adapter) ?? common.adapterOptions
		out.push(
			await runAdapter({
				...common,
				adapter,
				adapterOptions,
			})
		)
	}

	return out
}

/**
 * Validate an emitted row. Cheap; runs once per row. Catches adapter bugs early so the JSONL doesn't end up
 * half-malformed.
 */
function assertEmittedRow(adapter: CorpusAdapter, row: CanonicalRow): void {
	if (row.source !== adapter.id) {
		throw new Error(`adapter ${adapter.id}: row.source must equal adapter.id (got ${JSON.stringify(row.source)})`)
	}

	if (!row.source_id) {
		throw new Error(`adapter ${adapter.id}: row.source_id is empty`)
	}

	if (!row.raw) {
		throw new Error(`adapter ${adapter.id}: row.raw is empty for source_id=${row.source_id}`)
	}

	if (!row.country) {
		throw new Error(`adapter ${adapter.id}: row.country is empty for source_id=${row.source_id}`)
	}

	if (!row.license) {
		throw new Error(`adapter ${adapter.id}: row.license is empty for source_id=${row.source_id}`)
	}
}

/** Promise-ify a single event emission. Used to await `drain` / `close` on the write stream. */
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

/** Convenience: ensure the parent directory of `filePath` exists. */
export async function ensureParentDir(filePath: string): Promise<void> {
	await mkdir(dirname(filePath), { recursive: true })
}
