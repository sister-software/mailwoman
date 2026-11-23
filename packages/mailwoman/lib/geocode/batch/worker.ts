// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * Runs inside a worker thread (spawned by `geocodeStream` or `geocodeInputs`
 * via `spliterator.parallelMapWorkers`).
 *
 * Top-level code is per-worker init: it builds the routed geocode sessions of the serializable
 * `workerData.userData` config (`#geocode/batch/config`), the sessions `mailwoman geocode` builds.
 * The sessions live as long as the worker thread, and the pool terminates the thread.
 */

import { workerUserData } from "@mailwoman/core/scripting/workers"
import { makeGeocodeHandler, type SourceRecord } from "@mailwoman/entity-resolution"

import { createBatchGeocodeSessions } from "#geocode/batch/config"
import { ingestGeocoderOf } from "#geocode/batch/ingest"
import type { GeocodeBatchInput, GeocodeBatchOutput, GeocodeWorkerData } from "#geocode/batch/stream"

const data = workerUserData<GeocodeWorkerData>()
const sessions = createBatchGeocodeSessions(data.geocode)

const handleRecord =
	data.kind === "records"
		? makeGeocodeHandler(ingestGeocoderOf(await sessions.sessionFor(), data.country ?? undefined), data.mapping)
		: null

/**
 * Per-item handler the worker pool invokes: a record under `geocodeStream`, an input under `geocodeInputs`.
 */
export async function handleItem(item: SourceRecord | GeocodeBatchInput): Promise<SourceRecord | GeocodeBatchOutput> {
	if (handleRecord) return handleRecord(item as SourceRecord)

	// The coordinator sends inputs to a worker it started with `kind: "inputs"`.
	const { id, input, country, defaultCountry, fuzzyCountryScope } = item as GeocodeBatchInput
	const route = { ...(country ? { country } : {}), ...(defaultCountry ? { defaultCountry } : {}) }

	const run = await sessions.geocode(input, route, fuzzyCountryScope ? { fuzzyCountryScope } : {}).catch((error) => {
		throw new Error(`geocoding ${id} failed: ${(error as Error).message}`, { cause: error })
	})

	const routedLocale = country ? data.geocode.localeByCountry?.[country.toUpperCase()] : undefined

	return { id, result: run.result, baseOnly: !!routedLocale && sessions.unavailableLocales.has(routedLocale) }
}
