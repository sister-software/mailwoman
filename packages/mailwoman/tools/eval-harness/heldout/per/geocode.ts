// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Geocodes held-out rows with one arm and grades each result (`heldout/per/geocode/outcome`).
 *
 *   The geocode is the gauntlet's (`gauntlet/harness` `buildGauntletDeps`): the arm's weights
 *   cache loaded as production loads it, the row's country selecting its weights overlay,
 *   and the production resolver with the arm's pins (`heldout/per/arm`) over the data root's databases.
 *   It is the path the regression board and `mwdev_compare` grade a resolver change on.
 *
 *   With more than one worker the rows are geocoded on a pool of worker threads
 *   (`geocode/worker`), each holding its own geocoder built the same way.
 *   A row's outcome reads no other row's geocode, so the outcomes are the single-thread path's.
 *   `geocode.integration.test.ts` checks that row for row.
 */

import { parallelMapWorkers } from "spliterator"

import { buildGauntletDeps, type GauntletDeps, PRODUCTION_RESOLVER_PINS } from "#tools/eval-harness/gauntlet/harness"
import type { HeldoutArm } from "#tools/eval-harness/heldout/per/arm"
import { type HeldoutRow, heldoutRowID } from "#tools/eval-harness/heldout/per/country"
import { type HeldoutGeocodeOutcome, scoreGeocodeOutcome } from "#tools/eval-harness/heldout/per/geocode/outcome"

const GEOCODE_WORKER_URL = new URL(
	import.meta.url.endsWith(".ts") ? "./geocode/worker.ts" : "./geocode/worker.js",
	import.meta.url
)

/**
 * The geocode rule a report records beside its geocode outcomes.
 */
export const HELDOUT_GEOCODE_RULE =
	"gauntlet-geocode: each row is geocoded by buildGauntletDeps over the arm's weights cache, with the row's " +
	"country as caseCountry (its weights overlay) and production resolver pins except the arm's own; the outcome " +
	"is exact when the resolved components (components and dropped_components, folded, the street family joined " +
	"under the whole convention) equal the expected spans and every expected locality, dependent_locality, " +
	"subregion, region and country span is a hierarchy entry at its tag."

/**
 * Geocodes and grades one row with a geocoder built for `arm`.
 *
 * @throws When the geocode throws, naming the row.
 */
export async function geocodeHeldoutRow(
	deps: Pick<GauntletDeps, "geocode">,
	row: HeldoutRow,
	arm: Pick<HeldoutArm, "label">
): Promise<{ id: string; outcome: HeldoutGeocodeOutcome }> {
	const id = heldoutRowID(row)

	try {
		const result = await deps.geocode(row.raw, row.country ? { caseCountry: row.country } : {})

		return { id, outcome: scoreGeocodeOutcome(row, result) }
	} catch (error) {
		throw new Error(`geocoding ${id} with ${arm.label} failed: ${(error as Error).message}`, { cause: error })
	}
}

/**
 * Builds the geocoder an arm's rows are geocoded with.
 */
export function buildHeldoutGeocoder(arm: Pick<HeldoutArm, "cacheRoot" | "pins">): Promise<GauntletDeps> {
	return buildGauntletDeps({ weightsCacheRoot: arm.cacheRoot, pins: { ...PRODUCTION_RESOLVER_PINS, ...arm.pins } })
}

export interface GeocodeHeldoutOptions {
	/**
	 * Worker threads, each with its own geocoder.
	 * One geocodes on the calling thread.
	 *
	 * @defaultValue 1
	 */
	workers?: number
	onRow?: (done: number, total: number) => void
}

/**
 * Geocodes `rows` with `arm` and returns each row's outcome by row identity.
 *
 * @throws When a geocode throws, naming the row, or when fewer rows came back than were sent.
 */
export async function geocodeHeldoutRows(
	rows: readonly HeldoutRow[],
	arm: HeldoutArm,
	options: GeocodeHeldoutOptions = {}
): Promise<Map<string, HeldoutGeocodeOutcome>> {
	const outcomes = new Map<string, HeldoutGeocodeOutcome>()
	const workers = options.workers ?? 1

	if (workers > 1) {
		for await (const { id, outcome } of parallelMapWorkers<HeldoutRow, { id: string; outcome: HeldoutGeocodeOutcome }>(
			rows,
			{ worker: GEOCODE_WORKER_URL, concurrency: workers, batchSize: 16, workerData: { arm } }
		)) {
			outcomes.set(id, outcome)
			options.onRow?.(outcomes.size, rows.length)
		}

		if (outcomes.size !== rows.length) {
			throw new Error(`geocoded ${outcomes.size} of ${rows.length} rows with ${arm.label}`)
		}

		return outcomes
	}

	using deps = await buildHeldoutGeocoder(arm)

	for (const row of rows) {
		const { id, outcome } = await geocodeHeldoutRow(deps, row, arm)

		outcomes.set(id, outcome)
		options.onRow?.(outcomes.size, rows.length)
	}

	return outcomes
}
