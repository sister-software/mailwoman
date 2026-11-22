// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * Runs inside a worker thread (spawned by `geocodeStream` via `spliterator.parallelMap`).
 *
 * Top-level code is per-worker init: it builds one geocode session from the serializable
 * `workerData.userData` config (paths + locale), the session `mailwoman geocode` builds.
 * Each dispatched record is geocoded by `makeGeocodeHandler`.
 */

import { workerData } from "node:worker_threads"

import { type ColumnMapping, makeGeocodeHandler } from "@mailwoman/entity-resolution"

import { ingestGeocoderOf } from "#geocode/ingest"
import { createGeocodeSessionOptions } from "#geocode/options"
import { createGeocodeSession } from "#geocode/session"
import type { GeocodeStreamConfig } from "#geocode/stream"
import { NODE_LAYER_CONTRIBUTIONS } from "#services/entry/node"

const { mapping, geocode: cfg } = (workerData?.userData ?? {}) as {
	mapping: ColumnMapping
	geocode: GeocodeStreamConfig
}

// country-branch: a batch run that states no country resolves every row as a US address.
// The commit that added the fallback recorded no reason, and the region of `cfg.locale` would replace it.
const country = cfg.country ?? "US"

// A row geocoded in bulk answers as the same row does through `mailwoman geocode`,
// so the worker composes every layer that command composes.
// The country is the caller's scope, and the coarse placer stays off beside it.
// The session lives as long as the worker thread, and the pool terminates the thread.
const session = await createGeocodeSession(
	createGeocodeSessionOptions({
		locale: cfg.locale,
		dataRoot: cfg.dataRoot,
		resolveDB: cfg.wofDBPath,
		defaultCountry: country,
		placeCountry: false,
	}),
	{ layers: NODE_LAYER_CONTRIBUTIONS }
)

/**
 * Per-item handler the worker pool invokes.
 *
 * Bound to this worker's geocoder and mapping at module load, so each item costs only the geocode itself.
 */
export const handleItem = makeGeocodeHandler(ingestGeocoderOf(session, cfg.country), mapping)
