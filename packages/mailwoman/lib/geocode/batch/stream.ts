// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * This module geocodes records and inputs across worker threads using `spliterator.parallelMapWorkers`.
 *
 * Each worker builds the routed geocode sessions of one {@link GeocodeBatchConfig} at startup
 * (`#geocode/batch/config`), the sessions a caller on the calling thread builds from the same config.
 * Workers return items in completion order.
 *
 * {@linkcode geocodeStream} geocodes the normalized records of `@mailwoman/entity-resolution`'s
 * `normalizeCSV`, and {@linkcode geocodeInputs} geocodes address strings, each with its own route.
 *
 * Threads provide the available concurrency because `onnxruntime-node`'s `session.run()`
 * blocks the JS thread and `node:sqlite` reads are synchronous.
 */

import type { GeocodeResult } from "@mailwoman/core/geocode"
import { availableParallelism } from "@mailwoman/core/utils/system"
import type { ColumnMapping, SourceRecord } from "@mailwoman/entity-resolution"
import { parallelMapWorkers } from "spliterator"

import type { GeocodeBatchConfig } from "#geocode/batch/config"
import type { GeocodeRoute } from "#geocode/session/routes"

/**
 * The worker pool a bulk geocode runs on.
 */
export interface GeocodeBatchPoolOptions {
	/**
	 * Worker pool size.
	 * Each worker loads the model and opens the databases.
	 *
	 * @defaultValue {@linkcode DEFAULT_GEOCODE_WORKERS}, or the host's parallelism when that's smaller
	 */
	concurrency?: number
	/**
	 * Items per dispatched batch.
	 *
	 * @defaultValue `16`
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
 * The worker count a bulk geocode runs with by default.
 *
 * On a 16-core host, 2,000 held-out rows geocoded at 13, 26, 44, 55 and 51 rows per
 * second with 1, 2, 4, 8 and 12 workers: 12 workers ran slower than 8.
 */
export const DEFAULT_GEOCODE_WORKERS = 8

export interface GeocodeStreamOptions extends GeocodeBatchPoolOptions {
	/**
	 * The same {@link ColumnMapping} used to normalize.
	 * The worker recomputes the address from it.
	 */
	mapping: ColumnMapping
	/**
	 * The sessions each worker builds.
	 *
	 * A record ingest resolves under a default country and leaves the coarse placer off,
	 * so an unstated `defaultCountry` is `"US"` and an unstated `placeCountry` is off.
	 */
	geocode: GeocodeBatchConfig
}

/**
 * One address string a bulk geocode answers, with the route its session is chosen by.
 */
export interface GeocodeBatchInput extends Pick<GeocodeRoute, "country" | "defaultCountry"> {
	/**
	 * The caller's identity for the input, returned beside its result.
	 */
	id: string
	input: string
	/**
	 * The country the typo-fuzzy tier scopes its matches to.
	 */
	fuzzyCountryScope?: string
}

/**
 * The geocode of one {@link GeocodeBatchInput}.
 */
export interface GeocodeBatchOutput {
	id: string
	result: GeocodeResult
	/**
	 * Whether the input's routed locale failed to load, so it was parsed under the base locale.
	 */
	baseOnly: boolean
}

/**
 * What the coordinator sends every worker.
 */
export type GeocodeWorkerData =
	| { kind: "records"; mapping: ColumnMapping; country: string | null; geocode: GeocodeBatchConfig }
	| { kind: "inputs"; geocode: GeocodeBatchConfig }

/**
 * The worker entry, resolved through the package's `#` imports: the source module
 * under Node's type stripping and the compiled one elsewhere.
 */
const GEOCODE_WORKER_URL = new URL(import.meta.resolve("#geocode/batch/worker"))

function poolOptions(opts: GeocodeBatchPoolOptions, workerData: GeocodeWorkerData) {
	return {
		worker: opts.worker ?? GEOCODE_WORKER_URL,
		concurrency: opts.concurrency ?? Math.min(DEFAULT_GEOCODE_WORKERS, availableParallelism()),
		batchSize: opts.batchSize ?? 16,
		workerData,
	}
}

/**
 * Geocode `records` across a worker pool, yielding enriched {@link SourceRecord}s
 * (with `address` populated) in completion order.
 */
export function geocodeStream(
	records: AsyncIterable<SourceRecord> | Iterable<SourceRecord>,
	opts: GeocodeStreamOptions
): AsyncIterableIterator<SourceRecord> {
	const session = opts.geocode.session ?? {}

	return parallelMapWorkers<SourceRecord, SourceRecord>(
		records,
		poolOptions(opts, {
			kind: "records",
			mapping: opts.mapping,
			country: session.defaultCountry ?? null,
			geocode: {
				...opts.geocode,
				session: {
					// country-branch: a batch run that states no country resolves every row as a US address.
					// The commit that added the fallback recorded no reason, and the region
					// of the locale would replace it.
					defaultCountry: "US",
					placeCountry: false,
					...session,
				},
			},
		})
	)
}

/**
 * Geocode `inputs` across a worker pool, yielding each input's result in completion order.
 */
export function geocodeInputs(
	inputs: AsyncIterable<GeocodeBatchInput> | Iterable<GeocodeBatchInput>,
	config: GeocodeBatchConfig,
	opts: GeocodeBatchPoolOptions = {}
): AsyncIterableIterator<GeocodeBatchOutput> {
	return parallelMapWorkers<GeocodeBatchInput, GeocodeBatchOutput>(
		inputs,
		poolOptions(opts, { kind: "inputs", geocode: config })
	)
}
