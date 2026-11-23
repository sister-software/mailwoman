// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The `parallelMapWorkers` handler behind `geocodeHeldoutRows`.
 *
 *   Each worker thread builds one geocoder for the arm in its `userData`
 *   (`buildHeldoutGeocoder`), as the single-thread path does, and geocodes
 *   and grades the rows dispatched to it with `geocodeHeldoutRow`.
 */

import { workerUserData } from "@mailwoman/core/scripting/workers"

import type { HeldoutArm } from "#tools/eval-harness/heldout/per/arm"
import type { HeldoutRow } from "#tools/eval-harness/heldout/per/country"
import { buildHeldoutGeocoder, geocodeHeldoutRow } from "#tools/eval-harness/heldout/per/geocode"
import type { HeldoutGeocodeOutcome } from "#tools/eval-harness/heldout/per/geocode/outcome"

const { arm } = workerUserData<{ arm: HeldoutArm }>()

const deps = await buildHeldoutGeocoder(arm)

/**
 * Geocodes and grades one row.
 */
export function handleItem(row: HeldoutRow): Promise<{ id: string; outcome: HeldoutGeocodeOutcome }> {
	return geocodeHeldoutRow(deps, row, arm)
}
