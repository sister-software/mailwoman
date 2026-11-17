// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Geocodes held-out rows with one arm and grades each result (`heldout/per/geocode-outcome`).
 *
 *   The geocode is the gauntlet's (`gauntlet/harness` `buildGauntletDeps`): the arm's weights
 *   cache loaded as production loads it, the row's country selecting its weights overlay,
 *   and the production resolver with the arm's pins (`heldout/per/arm`) over the data root's databases.
 *   It is the path the regression board and `mwdev_compare` grade a resolver change on.
 */

import { buildGauntletDeps, PRODUCTION_RESOLVER_PINS } from "#tools/eval-harness/gauntlet/harness"
import type { HeldoutArm } from "#tools/eval-harness/heldout/per/arm"
import { type HeldoutRow, heldoutRowID } from "#tools/eval-harness/heldout/per/country"
import { type HeldoutGeocodeOutcome, scoreGeocodeOutcome } from "#tools/eval-harness/heldout/per/geocode-outcome"

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
 * Geocodes `rows` with `arm` and returns each row's outcome by row identity.
 *
 * @throws When a geocode throws, naming the row.
 */
export async function geocodeHeldoutRows(
	rows: readonly HeldoutRow[],
	arm: HeldoutArm,
	onRow?: (done: number, total: number) => void
): Promise<Map<string, HeldoutGeocodeOutcome>> {
	using deps = await buildGauntletDeps({
		weightsCacheRoot: arm.cacheRoot,
		pins: { ...PRODUCTION_RESOLVER_PINS, ...arm.pins },
	})

	const outcomes = new Map<string, HeldoutGeocodeOutcome>()

	for (const row of rows) {
		const rowID = heldoutRowID(row)

		try {
			const result = await deps.geocode(row.raw, row.country ? { caseCountry: row.country } : {})

			outcomes.set(rowID, scoreGeocodeOutcome(row, result))
		} catch (error) {
			throw new Error(`geocoding ${rowID} with ${arm.label} failed: ${(error as Error).message}`, { cause: error })
		}

		onRow?.(outcomes.size, rows.length)
	}

	return outcomes
}
