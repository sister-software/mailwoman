// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * This module geocodes normalized records across worker threads using `spliterator.parallelMapWorkers`.
 *
 * The pipeline composes it after `@mailwoman/entity-resolution`'s `normalizeCSV`.
 * Each worker builds one geocode session from {@link GeocodeStreamConfig} at startup.
 * Workers
 * return records in completion order. The work is latency- and memory-bound, so concurrency stays low.
 * A measured NPPES sweep peaked at 2 workers (~1.4x) and degraded at higher counts
 * because the shared database and memory bandwidth set the limit.
 * Threads provide the available concurrency because `onnxruntime-node`'s `session.run()`
 * blocks the JS thread and `node:sqlite` reads are synchronous.
 */

import { availableParallelism } from "@mailwoman/core/utils/system"
import type { ColumnMapping, SourceRecord } from "@mailwoman/entity-resolution"
import { parallelMapWorkers } from "spliterator"

import type { SessionOptionSource } from "#geocode/options"

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
	 * Classifier weights locale, such as `"fr-FR"`, or the session's default locale when omitted.
	 */
	locale?: string
	/**
	 * Where {@linkcode locale} came from, as the caller that built this config knows it.
	 *
	 * Each worker's session records it unchanged.
	 * Omitted, a stated locale is recorded as the caller's and an omitted one as the default.
	 */
	localeSource?: SessionOptionSource
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
	 * Each worker loads the model and opens the DB.
	 *
	 * @defaultValue Math.min(4, availableParallelism())
	 */
	concurrency?: number
	/**
	 * Records per dispatched batch.
	 *
	 * @defaultValue `32`
	 */
	batchSize?: number
	/**
	 * Override the worker module.
	 *
	 * Tests inject a fake.
	 *
	 * @defaultValue the real geocode worker.
	 */
	worker?: string | URL
}

/**
 * The worker entry, resolved through the package's `#` imports: the source module
 * under Node's type stripping and the compiled one elsewhere.
 */
const GEOCODE_WORKER_URL = new URL(import.meta.resolve("#geocode/worker"))

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
