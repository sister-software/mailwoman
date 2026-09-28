/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * The heavy, threaded half of the parallel-ingest split: geocode a stream of normalized records across worker
 * threads (`spliterator.parallelMapWorkers`), composed after `@mailwoman/registry`'s `normalizeCSV`. Each worker
 * rebuilds the classifier, WOF lookup, resolver, and databases from {@link GeocodeStreamConfig} at startup, and
 * records arrive in completion order. Concurrency is low on purpose: geocoding is latency- and memory-bound, and
 * a measured NPPES sweep peaked at 2 workers (~1.4x) and degraded past that, because the shared DB plus memory
 * bandwidth is the ceiling rather than the core count. Threads are the only change available, because
 * `onnxruntime-node`'s `session.run()` blocks the JS thread and `node:sqlite` reads are synchronous, so a
 * separate runtime per row — a worker — is what provides concurrency.
 */

import { availableParallelism } from "@mailwoman/core/utils/system"
import type { ColumnMapping, SourceRecord } from "@mailwoman/registry"
import { parallelMapWorkers } from "spliterator"

export interface GeocodeStreamConfig {
	/**
	 * Path to the WOF admin SQLite DB, opened read-only per worker (shared OS page cache).
	 */
	wofDBPath: string
	/**
	 * Mailwoman data root.
	 * Geometry databases live under here.
	 */
	dataRoot: string
	/**
	 * Classifier weights locale, e.g. `"en-US"`.
	 */
	locale: string
	/**
	 * Default country for resolution, e.g. `"US"`.
	 */
	country?: string
}

export interface GeocodeStreamOptions {
	/**
	 * The same {@link ColumnMapping} used to normalize.
	 * The worker recomputes the address from it.
	 */
	mapping: ColumnMapping
	/**
	 * Serializable geocoder config the worker rebuilds its dependencies from.
	 */
	geocode: GeocodeStreamConfig
	/**
	 * Worker pool size.
	 *
	 * Keep it small, because throughput peaks at about 2 workers and degrades past that,
	 * and each worker loads the model and opens the DB. @default Math.min(4, availableParallelism())
	 */
	concurrency?: number
	/**
	 * Records per dispatched batch. @default 32
	 */
	batchSize?: number
	/**
	 * Override the worker module.
	 *
	 * Tests inject a fake.
	 * Defaults to the real geocode worker.
	 */
	worker?: string | URL
}

/**
 * The compiled worker, resolved whether this runs from `out/` (prod) or `.ts` source (tests):
 * `lib/` and `out/` are siblings, so `../` is the package root either way.
 */
const GEOCODE_WORKER_URL = new URL("../out/geocode-worker.js", import.meta.url)

/**
 * Geocode `records` across a worker pool, yielding enriched {@link SourceRecord}s
 * (with `address` populated) in completion order.
 */
export function geocodeStream(
	records: AsyncIterable<SourceRecord> | Iterable<SourceRecord>,
	opts: GeocodeStreamOptions
): AsyncIterableIterator<SourceRecord> {
	return parallelMapWorkers<SourceRecord, SourceRecord>(records, {
		worker: opts.worker ?? GEOCODE_WORKER_URL,
		concurrency: opts.concurrency ?? Math.min(4, availableParallelism()),
		batchSize: opts.batchSize ?? 32,
		workerData: { mapping: opts.mapping, geocode: opts.geocode },
	})
}
