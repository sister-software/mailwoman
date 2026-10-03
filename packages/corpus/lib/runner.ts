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

import { canonicalDedupKey } from "#adapters/dedup-key"
import type { AdapterRegistry } from "#adapters/registry"
import { streamingSha256, type StreamingHasher } from "#adapters/sha256-stream"
import { FingerprintSet } from "#fingerprints"
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
 * Base-2 logarithm of the fingerprint table's slot count.
 *
 * 2^27 slots hold 93,952,409 keys before the load limit.
 * The largest measured adapter has 57,570,829 distinct keys.
 * The table occupies 2.0 GiB outside the V8 heap.
 */
export const DEFAULT_DEDUP_SLOTS_LOG2 = 27

/**
 * How many distinct dedup keys a `Set`-backed run holds before it stops adding new ones.
 *
 * A V8 `Set` refuses a 16,777,216th entry outright, so this cap was a real bound rather than a preference.
 * It applies only to a run that opts out of the fingerprint table
 * through {@linkcode RunAdapterOptions.dedupMaxSize}.
 */
export const DEFAULT_DEDUP_MAX_SIZE = 10_000_000

/**
 * Where a run held its dedup keys.
 */
export const DedupStore = {
	/**
	 * 128-bit fingerprints in a flat `Uint32Array`, bounded by the array the run sized.
	 */
	FingerprintTable: "fingerprint-table",

	/**
	 * A V8 `Set` of key strings, capped because V8 refuses a 16,777,216th entry.
	 */
	CappedSet: "capped-set",
} as const

export type DedupStore = (typeof DedupStore)[keyof typeof DedupStore]

export interface RunAdapterOptions {
	adapter: CorpusAdapter

	adapterOptions: AdapterOptions

	/**
	 * Hold dedup keys in a V8 `Set` capped at this many, rather than in a fingerprint table.
	 *
	 * The cap is what the fingerprint table replaces.
	 * A run that sets this reproduces the pre-2026-09-28 behavior.
	 *
	 * Past the cap, the runner still drops a duplicate of a key it holds
	 * and writes a duplicate of a key first seen after the cap.
	 *
	 * Over `v0.7.0-de-holdout` that wrote 1,490,992 duplicate rows across three adapters.
	 * A test sets it low to reach exhaustion in a few rows.
	 *
	 * After reaching the cap, the runner still drops duplicates for keys already in the set.
	 * It writes duplicates for keys first seen after the cap.
	 */
	dedupMaxSize?: number

	/**
	 * Base-2 logarithm of the fingerprint table's slot count.
	 *
	 * Defaults to {@linkcode DEFAULT_DEDUP_SLOTS_LOG2}.
	 * A test sets it low to keep the allocation small.
	 */
	dedupSlotsLog2?: number

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
	 * corpus already contains makes this run's rows indistinguishable from that corpus's.
	 * When absent, rows use `adapter.id`.
	 */
	sourceName?: string

	/**
	 * Invoked every `progressEvery` rows yielded and once at the end.
	 * A thrown error aborts the run.
	 */
	onProgress?: (snapshot: RunnerProgress) => void

	/**
	 * Yielded-row interval at which `onProgress` fires.
	 *
	 * Defaults to 1000 rows per callback.
	 * The runner always emits a terminal update.
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
	 * Input records the adapter refused or trimmed before yielding, keyed by reason.
	 *
	 * See {@link AdapterOptions.dropped} for the key shapes.
	 * An empty object means the adapter does not count its drops, so the number it dropped is unmeasured.
	 */
	dropped: Record<string, number>
	/**
	 * The `yielded` count at which the dedup set stopped growing, or `null` where it never did.
	 *
	 * A run reporting a number here deduplicated its rows completely up to that point.
	 * After that point, it still drops duplicates for keys already held.
	 *
	 * It writes duplicates for keys first seen after the cap.
	 * `deduped` by itself cannot identify which, so a consumer comparing two builds'
	 * duplicate counts needs this beside it.
	 */
	dedup_exhausted_at_yielded: number | null
	/**
	 * How the run held its dedup keys: `fingerprint-table` or `capped-set`.
	 *
	 * The two reach different row counts on the same input, so a consumer comparing
	 * two builds needs to know which each used.
	 * `capped-set` writes a duplicate of any key first seen after its cap.
	 */
	dedup_store: DedupStore
	/**
	 * Distinct dedup keys the run held at the end.
	 *
	 * Under `fingerprint-table` this is a fingerprint count, so two keys sharing all 128 bits count once.
	 */
	dedup_keys: number
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
	const { adapter, outputDir, corpusVersion } = opts
	// A caller that passes its own map reads the counts back from it.
	// Otherwise the runner supplies one, so every manifest carries the adapter's drop reasons.
	const dropped = opts.adapterOptions.dropped ?? new Map<string, number>()
	const adapterOptions: AdapterOptions = { ...opts.adapterOptions, dropped }
	const progressEvery = opts.progressEvery ?? 1000

	const adapterDir = resolvePathBuilder(outputDir, adapter.id)
	await makeDirectories(adapterDir)

	const jsonlPath = adapterDir("canonical.jsonl")
	const manifestPath = adapterDir("MANIFEST.json")

	const startedAt = new Date()
	const t0 = performance.now()

	const stream = openWriteStream(jsonlPath, { encoding: "utf8" })
	const hasher: StreamingHasher = streamingSha256()

	// The `Set` path serves callers that cannot accept a fingerprint collision dropping a legitimate row.
	// A test also uses it to reach the capped behavior in three rows.
	// Every other run takes the table.
	// Its entry count is bounded by the array it sized rather than by V8's `Set` limit.
	const capped = opts.dedupMaxSize !== undefined
	const seen = capped ? new Set<string>() : null
	const fingerprints = capped ? null : new FingerprintSet(opts.dedupSlotsLog2 ?? DEFAULT_DEDUP_SLOTS_LOG2)
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

			if (fingerprints) {
				// The table holds every key the run has seen, so a duplicate is refused wherever it arrives.
				if (!fingerprints.add(key)) {
					if (yielded % progressEvery === 0) {
						emitProgress()
					}

					continue
				}
			} else if (seen) {
				// The membership test runs whether or not the set is full.
				// The cap stops the set from growing.
				// The set still rejects every duplicate of a key it holds.
				// Without the membership test at the cap, duplicates of the first
				// `dedupMaxSize` keys passed through.
				// This ordering keeps those duplicates out.
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
		dropped: Object.fromEntries([...dropped].toSorted(([a], [b]) => a.localeCompare(b))),
		dedup_exhausted_at_yielded: dedupExhaustedAtYielded,
		dedup_store: fingerprints ? DedupStore.FingerprintTable : DedupStore.CappedSet,
		dedup_keys: fingerprints?.size ?? seen?.size ?? 0,
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

	// `country_weights` and every country filter use this value.
	// Validate its ISO 3166-1 alpha-2 shape.
	// `ZZ` and `XK` are legitimate codes even though ISO membership does not list them.
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
 * A zero-length write acts as a barrier.
 * Its callback runs after earlier queued writes.
 *
 * A caller can then record a byte offset for the bytes in the file.
 * `drain` fires only when the buffer was full.
 *
 * `bytesWritten` excludes queued data.
 * Neither value answers when all earlier writes have reached the file.
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
