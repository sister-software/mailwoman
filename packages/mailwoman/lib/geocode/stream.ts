/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * This module geocodes normalized records across worker threads using `spliterator.parallelMapWorkers`.
 * The pipeline composes it after `@mailwoman/registry`'s `normalizeCSV`. Each worker rebuilds the
 * classifier, WOF lookup, resolver and databases from {@link GeocodeStreamConfig} at startup. Workers
 * return records in completion order. The work is latency- and memory-bound, so concurrency stays low.
 * A measured NPPES sweep peaked at 2 workers (~1.4x) and degraded at higher counts because the shared
 * database and memory bandwidth set the limit. Threads provide the available concurrency because
 * `onnxruntime-node`'s `session.run()` blocks the JS thread and `node:sqlite` reads are synchronous.
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
	 * Keep it small because throughput peaks at about 2 workers and degrades past that.
	 * Each worker loads the model and opens the DB. @default Math.min(4, availableParallelism())
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
