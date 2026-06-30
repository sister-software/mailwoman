/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * The heavy, threaded half of the parallel-ingest split: geocode a stream of normalized records across
 * worker threads (`spliterator.parallelMap`). Compose it after `@mailwoman/registry`'s `normalizeCSV`,
 * filtering on the main thread first so you only geocode the rows you care about:
 *
 * ```ts
 * import { normalizeCSV } from "@mailwoman/registry"
 * import { geocodeStream } from "mailwoman/geocode-stream"
 *
 * const normalized = normalizeCSV("nppes.csv", { mapping })
 * for await (const rec of geocodeStream(normalized, { mapping, geocode })) sink.write(rec)
 * ```
 *
 * Each worker rebuilds the classifier / WOF lookup / resolver / shards from {@link GeocodeStreamConfig}
 * (paths + locale) at startup — nothing but config crosses out, only the enriched record crosses back.
 * Records arrive in completion order. Worth threading only because geocoding is ms-scale per row
 * (~23ms measured) — far above the cross-thread cost; for light normalization, stop after normalizeCSV.
 *
 * **Concurrency is low on purpose.** Geocoding is latency/memory-bound, not CPU-bound: each row makes
 * random reads into the multi-GB WOF SQLite, and the classifier already uses several cores per inference.
 * A measured NPPES sweep (single 4 GB DB, 16-core box) peaked at **2 workers (~1.4×)** and *degraded* from
 * there — 4 workers ≈ baseline, 6 ≈ no gain — because the shared DB + memory bandwidth is the ceiling, not
 * the core count. So the default is small, and more is usually worse. Sweep it for your data/box rather
 * than reaching for `availableParallelism()`.
 */

import { availableParallelism } from "node:os"

import type { ColumnMapping, SourceRecord } from "@mailwoman/registry"
import { parallelMap } from "spliterator"

export interface GeocodeStreamConfig {
	/** Path to the WOF admin SQLite DB. Opened read-only per worker (shared OS page cache). */
	wofDbPath: string
	/** Mailwoman data root (geometry shards live under here). */
	dataRoot: string
	/** Classifier weights locale, e.g. `"en-US"`. */
	locale: string
	/** Default country for resolution, e.g. `"US"`. */
	country?: string
}

export interface GeocodeStreamOptions {
	/** The same {@link ColumnMapping} used to normalize — the worker recomputes the address from it. */
	mapping: ColumnMapping
	/** Serializable geocoder config the worker rebuilds its deps from. */
	geocode: GeocodeStreamConfig
	/**
	 * Worker pool size. Keep it small — geocoding is I/O/memory-bound, so throughput peaks at ~2 workers and degrades
	 * past that (see the module doc). Bounded by RAM too (each worker loads the model + opens the DB).
	 *
	 * @default Math.min(4, availableParallelism())
	 */
	concurrency?: number
	/** Records per dispatched batch. @default 32 */
	batchSize?: number
	/** Override the worker module — tests inject a fake. Defaults to the real geocode worker. */
	worker?: string | URL
}

/** The compiled worker, resolved whether this runs from `out/` (prod) or `.ts` source (tests). */
const GEOCODE_WORKER_URL = new URL(
	import.meta.url.includes("/out/") ? "./geocode-worker.js" : "./out/geocode-worker.js",
	import.meta.url
)

/**
 * Geocode `records` across a worker pool, yielding enriched {@link SourceRecord}s (with `address` populated) in
 * completion order. See the module doc for composition + the in-worker dep rebuild.
 */
export function geocodeStream(
	records: AsyncIterable<SourceRecord> | Iterable<SourceRecord>,
	opts: GeocodeStreamOptions
): AsyncIterableIterator<SourceRecord> {
	return parallelMap<SourceRecord, SourceRecord>(records, {
		worker: opts.worker ?? GEOCODE_WORKER_URL,
		concurrency: opts.concurrency ?? Math.min(4, availableParallelism()),
		batchSize: opts.batchSize ?? 32,
		workerData: { mapping: opts.mapping, geocode: opts.geocode },
	})
}
