// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Geocodes held-out rows with one arm and grades each result (`heldout/per/geocode/outcome`).
 *
 *   The rows are geocoded in bulk (`geocodeInputs` in `#geocode/batch/stream`) by the gauntlet's
 *   geocode sessions (`gauntletBatchConfig` in `gauntlet/harness`): the arm's weights cache
 *   loaded as production loads it, the row's country selecting its weights overlay, and the
 *   production resolver with the arm's pins (`heldout/per/arm`) over the data root's databases.
 *   The regression board and `mwdev_compare` build the same sessions on the calling thread.
 *
 *   A row's outcome reads no other row's geocode, so the outcomes don't depend on the worker count.
 *   `geocode.integration.test.ts` checks the pool against the board's geocoder row for row.
 */

import type { GeocodeBatchConfig } from "#geocode/batch/config"
import { geocodeInputs } from "#geocode/batch/stream"
import {
	assertDeclaredAnchorBins,
	gauntletBatchConfig,
	PRODUCTION_RESOLVER_PINS,
} from "#tools/eval-harness/gauntlet/harness"
import { OVERLAY_LOCALE_BY_COUNTRY } from "#tools/eval-harness/gauntlet/routing"
import type { HeldoutArm } from "#tools/eval-harness/heldout/per/arm"
import { type HeldoutRow, heldoutRowID } from "#tools/eval-harness/heldout/per/country"
import { type HeldoutGeocodeOutcome, scoreGeocodeOutcome } from "#tools/eval-harness/heldout/per/geocode/outcome"

/**
 * The geocode rule a report records beside its geocode outcomes.
 */
export const HELDOUT_GEOCODE_RULE =
	"gauntlet-geocode-session: each row is geocoded by the gauntlet's geocode sessions (gauntletBatchConfig) over " +
	"the arm's weights cache, with the row's country selecting its weights overlay and production resolver pins " +
	"except the arm's own; the outcome is exact when the resolved components (components and dropped_components, " +
	"folded, the street family joined under the whole convention) equal the expected spans and every expected " +
	"locality, dependent_locality, subregion, region and country span is a hierarchy entry at its tag."

/**
 * The configuration an arm's rows are geocoded with.
 */
export function heldoutGeocodeConfig(arm: Pick<HeldoutArm, "cacheRoot" | "pins">): GeocodeBatchConfig {
	return gauntletBatchConfig({ weightsCacheRoot: arm.cacheRoot, pins: { ...PRODUCTION_RESOLVER_PINS, ...arm.pins } })
}

export interface GeocodeHeldoutOptions {
	/**
	 * Worker threads, each with its own geocode sessions.
	 *
	 * @defaultValue `DEFAULT_GEOCODE_WORKERS` in `#geocode/batch/stream`
	 */
	workers?: number
	onRow?: (done: number, total: number) => void
}

/**
 * Geocodes `rows` with `arm` and returns each row's outcome by row identity.
 *
 * @throws When the arm's cache lacks an anchor artifact its card declares,
 * when a geocode throws, or when fewer rows came back than were sent.
 */
export async function geocodeHeldoutRows(
	rows: readonly HeldoutRow[],
	arm: HeldoutArm,
	options: GeocodeHeldoutOptions = {}
): Promise<Map<string, HeldoutGeocodeOutcome>> {
	await assertDeclaredAnchorBins(["en-US", ...Object.values(OVERLAY_LOCALE_BY_COUNTRY)], arm.cacheRoot)

	const rowsByID = new Map(rows.map((row) => [heldoutRowID(row), row]))
	const outcomes = new Map<string, HeldoutGeocodeOutcome>()

	const inputs = [...rowsByID].map(([id, row]) => ({
		id,
		input: row.raw,
		...(row.country ? { country: row.country } : {}),
	}))

	const pool = options.workers ? { concurrency: options.workers } : {}

	for await (const { id, result } of geocodeInputs(inputs, heldoutGeocodeConfig(arm), pool)) {
		outcomes.set(id, scoreGeocodeOutcome(rowsByID.get(id)!, result))
		options.onRow?.(outcomes.size, rows.length)
	}

	if (outcomes.size !== rows.length) {
		throw new Error(`geocoded ${outcomes.size} of ${rows.length} rows with ${arm.label}`)
	}

	return outcomes
}
