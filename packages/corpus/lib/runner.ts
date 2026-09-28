/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Adapter runner — drives a `CorpusAdapter` to completion and writes `canonical.jsonl` plus a
 *   `MANIFEST.json` per adapter. It does not align, tokenize, synthesize, or write Parquet.
 */

import { isAlpha2CodeShape } from "@mailwoman/codex/country"
import { openWriteStream, type WriteStream } from "@mailwoman/core/fs/streams"
import { writeLocalJSONFile, makeDirectories } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/json"
import { type PathBuilderLike, resolvePathBuilder } from "path-ts"

import { canonicalDedupKey, streamingSha256, type AdapterRegistry, type StreamingHasher } from "#adapters/utils"
import type { AdapterOptions, CanonicalRow, CorpusAdapter } from "#types"

/**
 * Snapshot of the runner's state, emitted on every progress tick.
 */
export interface RunnerProgress {
	adapterID: string

	/**
	 * Total rows the adapter has yielded, before dedup.
	 */
	yielded: number

	written: number

	bytes: number

	elapsed_ms: number
}

/**
 * Per-invocation options for `runAdapter`.
 */
/**
 * How many distinct dedup keys the runner holds before it stops adding new ones.
 *
 * A V8 `Set` refuses a 16,777,216th entry outright, so the cap is a real bound rather than a preference.
 * Three adapters passed it in `v0.7.0-de-holdout`.
 */
export const DEFAULT_DEDUP_MAX_SIZE = 10_000_000

export interface RunAdapterOptions {
	adapter: CorpusAdapter

	adapterOptions: AdapterOptions

	/**
	 * How many distinct dedup keys to hold before the set stops growing.
	 *
	 * Defaults to {@linkcode DEFAULT_DEDUP_MAX_SIZE}.
	 * A test sets it low to reach exhaustion in a few rows.
	 *
	 * Past the cap the runner still drops a duplicate of a key it holds,
	 * and writes a duplicate of a key first seen after the cap.
	 */
	dedupMaxSize?: number

	/**
	 * Root output directory.
	 * The runner creates `<outputDir>/<adapter.id>/` under it.
	 */
	outputDir: PathBuilderLike

	/**
	 * Corpus version stamped onto every row, locked together with the tokenizer version.
	 */
	corpusVersion: string

	/**
	 * The `source` id stamped on every emitted row, when it differs from the adapter's own id.
	 *
	 * A source id is a wire identifier keyed by `source_weights`, so re-using a name a built
	 * corpus already carries makes this run's rows indistinguishable from that corpus's.
	 * When absent, rows carry `adapter.id`.
	 */
	sourceName?: string

	/**
	 * Invoked every `progressEvery` rows yielded and once at the end.
	 * A thrown error aborts the run.
	 */
	onProgress?: (snapshot: RunnerProgress) => void

	/**
	 * Yielded-row interval at which `onProgress` fires.
	 * Defaults to 1000, and the terminal tick is always emitted.
	 */
	progressEvery?: number
}

/**
 * Return value of `runAdapter`, the same shape as the manifest written to disk.
 */
export interface AdapterRunManifest {
	adapter_id: string
	corpus_version: string
	default_license: string
	description: string
	yielded: number
	written: number
	deduped: number
	/**
	 * The `yielded` count at which the dedup set stopped growing, or `null` where it never did.
	 *
	 * A run reporting a number here deduplicated its rows completely up to that point
	 * and partially after it: a row duplicating a key already held is still dropped,
	 * and a duplicate of a key first seen after the cap is written.
	 * `deduped` alone cannot say which, so a consumer comparing two builds'
	 * duplicate counts needs this beside it.
	 */
	dedup_exhausted_at_yielded: number | null
	bytes: number
	sha256: string
	jsonl_path: string
	started_at: string
	ended_at: string
	elapsed_ms: number
}

/**
 * Drive a single adapter to completion, writing its jsonl and manifest under `outputDir/<adapter.id>/`.
 */
export async function runAdapter(opts: RunAdapterOptions): Promise<AdapterRunManifest> {
	const { adapter, adapterOptions, outputDir, corpusVersion } = opts
	const progressEvery = opts.progressEvery ?? 1000

	const adapterDir = resolvePathBuilder(outputDir, adapter.id)
	await makeDirectories(adapterDir)

	const jsonlPath = adapterDir("canonical.jsonl")
	const manifestPath = adapterDir("MANIFEST.json")

	const startedAt = new Date()
	const t0 = performance.now()

	const stream = openWriteStream(jsonlPath, { encoding: "utf8" })
	const hasher: StreamingHasher = streamingSha256()
	const seen = new Set<string>()
	const dedupMaxSize = opts.dedupMaxSize ?? DEFAULT_DEDUP_MAX_SIZE
	let dedupExhausted = false
	let dedupExhaustedAtYielded: number | null = null

	let yielded = 0
	let written = 0
	let bytes = 0

	const emitProgress = (): void => {
		opts.onProgress?.({
			adapterID: adapter.id,
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

			const stamped: CanonicalRow = {
				...row,
				// The rename is the runner's, after `assertEmittedRow` has held the adapter to emitting its own id.
				source: opts.sourceName ?? row.source,
				corpus_version: corpusVersion,
				addressRole: row.addressRole ?? adapter.addressRole,
				// `register` is nullable and null is a statement rather than an absence,
				// so only an undefined field takes the adapter's declaration.
				register: row.register === undefined ? adapter.register : row.register,
				surface: row.surface ?? adapter.surface,
			}

			const key = canonicalDedupKey(stamped)

			// The membership test runs whether or not the set is full.
			// Exhaustion stops the set GROWING, and a set that has stopped growing still
			// rejects every duplicate of a key it holds.
			// Skipping the test once full let a row duplicating one of the first `dedupMaxSize` keys through.
			// This ordering exists to refuse that row.
			if (seen.has(key)) {
				if (yielded % progressEvery === 0) {
					emitProgress()
				}

				continue
			}

			if (!dedupExhausted) {
				if (seen.size >= dedupMaxSize) {
					dedupExhausted = true
					dedupExhaustedAtYielded = yielded

					process.stderr.write(
						`  runner: dedup set full at ${dedupMaxSize.toLocaleString()} keys after ${yielded.toLocaleString()} ` +
							`yielded rows — a later row duplicating a key already held is still dropped, and a duplicate of ` +
							`a key first seen from here on is written\n`
					)
				} else {
					seen.add(key)
				}
			}

			const line = `${stringifyJSON(stamped)}\n`
			hasher.update(line)
			bytes += Buffer.byteLength(line, "utf8")

			written++

			if (!stream.write(line)) {
				await once(stream, "drain")
			}

			if (yielded % progressEvery === 0) {
				emitProgress()
			}
		}
	} finally {
		stream.end()
		await once(stream, "close")
	}

	// Every adapter honors `signal` by returning instead, so without this a truncated
	// `canonical.jsonl` would be recorded as a finished run.
	adapterOptions.signal?.throwIfAborted()

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
		dedup_exhausted_at_yielded: dedupExhaustedAtYielded,
		bytes,
		sha256: hasher.digest(),
		jsonl_path: jsonlPath.toString(),
		started_at: startedAt.toISOString(),
		ended_at: endedAt.toISOString(),
		elapsed_ms,
	}

	await writeLocalJSONFile(manifest, manifestPath)

	return manifest
}

/**
 * Drive every adapter in a registry sequentially, stopping on the first failure.
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

function assertEmittedRow(adapter: CorpusAdapter, row: CanonicalRow): void {
	if (row.source !== adapter.id) {
		throw new Error(`adapter ${adapter.id}: row.source must equal adapter.id (got ${stringifyJSON(row.source)})`)
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

	// `country_weights` and every country filter key on this value, and the shape
	// rather than ISO membership because `ZZ` and `XK` are legitimate non-members.
	if (!isAlpha2CodeShape(row.country)) {
		throw new Error(
			`adapter ${adapter.id}: row.country ${stringifyJSON(row.country)} is not two upper-case letters ` +
				`for source_id=${row.source_id}. ISO 3166-1 alpha-2 is the shape country_weights and every ` +
				`country filter key on, so a code outside it trains on nothing and matches no filter.`
		)
	}

	if (!row.license) {
		throw new Error(`adapter ${adapter.id}: row.license is empty for source_id=${row.source_id}`)
	}
}

/**
 * Resolve once everything written to `stream` so far has reached the file.
 *
 * A zero-length write is the barrier: its callback runs after the writes queued before it,
 * so a caller that records a byte offset can state that the file holds those bytes.
 * `drain` fires only when the buffer was full, and `bytesWritten` excludes what
 * is still queued, so neither answers the question.
 */
export function flushStream(stream: WriteStream): Promise<void> {
	return new Promise((resolve, reject) => {
		stream.write("", (error) => (error ? reject(error) : resolve()))
	})
}

/**
 * Promise-ify a single `drain` or `close` emission, detaching the loser listener
 * so a long-lived stream does not accumulate an orphan handler per wait.
 */
export function once(emitter: WriteStream, event: "drain" | "close"): Promise<void> {
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
