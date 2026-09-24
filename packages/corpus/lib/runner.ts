/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Adapter runner — drives a `CorpusAdapter` to completion and writes intermediate jsonl + a
 *   per-adapter manifest.
 *
 *   Output layout under `outputDir`:
 *
 *   ```
 *   <outputDir>/<adapter.id>/
 *   canonical.jsonl       # one row per line, in emission order
 *   manifest.json         # adapter id, version, row count, sha256, license, started_at, ended_at
 * ```
 *
 *   The runner is responsible for everything an adapter is **not** responsible for:
 *
 *   - Stamping `corpus_version` on every row (adapters must not set it).
 *   - Stamping the adapter's `addressRole` on every row that omits one, so a single-role source declares its role once
 *       and a multi-role source overrides per row.
 *   - Applying `canonicalDedupKey` and skipping duplicates.
 *   - Streaming sha256 over jsonl bytes so the manifest checksum doesn't require a re-read.
 *   - Honoring backpressure on the output write stream.
 *   - Counting + emitting periodic progress to an optional callback.
 *   - Honoring `signal` (delegates to adapter's iteration boundary).
 *
 *   The runner does not perform alignment, tokenization, synthesis, or the Parquet write. Those
 *   steps run later, consuming the jsonl files this writes.
 */

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
	/**
	 * Adapter being driven.
	 */
	adapterID: string

	/**
	 * Total rows the adapter has yielded (before dedup).
	 */
	yielded: number

	/**
	 * Rows actually written to jsonl (after dedup).
	 */
	written: number

	/**
	 * Bytes written to jsonl so far.
	 */
	bytes: number

	/**
	 * Wall-clock milliseconds since the run started.
	 */
	elapsed_ms: number
}

/**
 * Per-invocation options for `runAdapter`.
 */
export interface RunAdapterOptions {
	/**
	 * Adapter to drive.
	 */
	adapter: CorpusAdapter

	/**
	 * Options handed to the adapter (input path, country filter, limit, signal).
	 */
	adapterOptions: AdapterOptions

	/**
	 * Root output directory.
	 * The runner creates `<outputDir>/<adapter.id>/` under it.
	 */
	outputDir: PathBuilderLike

	/**
	 * Corpus version stamped onto every row.
	 *
	 * Locked together with the tokenizer version.
	 */
	corpusVersion: string

	/**
	 * The `source` id stamped on every emitted row, when it differs from the adapter's own id.
	 *
	 * One adapter can produce slices that a training config has to weight apart.
	 * The `overture` adapter reads every country through the same code, and a run that weights
	 * Brazilian rows at the weight the European rows carry dilutes both: the 2026-07-18 arm
	 * created `overture-latam` for exactly that reason and had no way to ask the runner for it.
	 *
	 * A source id is a wire identifier, stored on every row of every built corpus
	 * and keyed by `source_weights`.
	 * Naming a new one is additive.
	 *
	 * Re-using a name that a built corpus already carries makes this run's rows
	 * indistinguishable from that corpus's, so pass one the config means.
	 *
	 * Absent, rows carry `adapter.id`, which is what every run before this option produced.
	 */
	sourceName?: string

	/**
	 * Optional progress callback.
	 *
	 * Invoked every `progressEvery` rows yielded (default 1000) and once at the end of the run.
	 * Errors thrown from this callback abort the run.
	 */
	onProgress?: (snapshot: RunnerProgress) => void

	/**
	 * Yielded-row interval at which `onProgress` fires.
	 *
	 * Defaults to 1000.
	 * The terminal tick is always emitted regardless of this value.
	 */
	progressEvery?: number
}

/**
 * Return value of `runAdapter`: the same shape as `manifest.json` on disk.
 */
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
 * @throws If the output directory cannot be created, if a row arrives with a
 * missing required field, or if the abort signal fires.
 * @returns the manifest describing the run.
 * Writes `canonical.jsonl` + `manifest.json` under `outputDir/<adapter.id>/`.
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
	const DEDUP_MAX_SIZE = 10_000_000
	let dedupExhausted = false

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
				// After `assertEmittedRow`, which holds every adapter to emitting its own id.
				// The rename is the runner's, so an adapter cannot quietly claim to be another one.
				source: opts.sourceName ?? row.source,
				corpus_version: corpusVersion,
				addressRole: row.addressRole ?? adapter.addressRole,
				// `register` is nullable and null is a statement rather than an absence,
				// so an adapter that means "this row names no published record" says so by setting it.
				// Only an undefined field takes the adapter's declaration.
				register: row.register === undefined ? adapter.register : row.register,
				surface: row.surface ?? adapter.surface,
			}

			const key = canonicalDedupKey(stamped)

			if (!dedupExhausted) {
				if (seen.has(key)) {
					if (yielded % progressEvery === 0) {
						emitProgress()
					}

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
		jsonl_path: jsonlPath.toString(),
		started_at: startedAt.toISOString(),
		ended_at: endedAt.toISOString(),
		elapsed_ms,
	}

	await writeLocalJSONFile(manifest, manifestPath)

	return manifest
}

/**
 * Drive every adapter in a registry sequentially.
 *
 * Stops on the first failure (caller can filter the registry before calling if partial-failure is desired).
 *
 * @returns The manifests in registry insertion order.
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
 * Validate an emitted row.
 *
 * Cheap.
 * Runs once per row.
 *
 * Catches adapter bugs early so the jsonl doesn't end up half-malformed.
 */
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

	// The shape as well as the presence.
	// `country` is the key `country_weights` is looked up by and the value every country
	// filter compares, so a code outside the ISO 3166-1 alpha-2 shape reaches a training run
	// as rows nothing admits and nothing selects, while every count of them looks ordinary.
	// WOF record 1141959953 publishes `Nl`, and `v0.6.0-register-surface` carries 431 rows under it.
	// `ZZ` is admitted here deliberately: the fragment recipes use it for a row whose country
	// is undetermined, which is a claim about the row rather than a malformed code (#2358).
	if (!/^[A-Z]{2}$/.test(row.country)) {
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
 * Promise-ify a single event emission.
 *
 * Used to await `drain` / `close` on the write stream.
 * Exported for `build.ts`, whose stage streams await `close` the same way.
 *
 * Unlike a bare two-listener race, the loser listener is detached so a long-lived
 * stream does not accumulate one orphan handler per wait.
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
