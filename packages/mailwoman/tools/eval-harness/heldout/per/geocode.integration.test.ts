// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The worker pool behind `geocodeHeldoutRows` against the single-thread path,
 *   on the installed weights and the data root's gazetteer.
 *
 *   A row's outcome reads no other row's geocode, so the two paths must agree row for row.
 *
 *   The guard asks the resolver for the model the loader opens, as the conformance suites do.
 */

import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { repoRootPath } from "@mailwoman/core/paths"
import { resolveWeights } from "@mailwoman/neural/weights"
import { wofDatabasePath } from "@mailwoman/resolver-wof-sqlite/paths"
import { describe, expect, it } from "vitest"

import type { HeldoutArm } from "#tools/eval-harness/heldout/per/arm"
import type { HeldoutRow } from "#tools/eval-harness/heldout/per/country"
import { geocodeHeldoutRows } from "#tools/eval-harness/heldout/per/geocode"

async function weightsPresent(): Promise<boolean> {
	try {
		return await pathExists((await resolveWeights({ locale: "en-us" })).modelPath)
	} catch {
		return false
	}
}

const gazetteerPresent = async (): Promise<boolean> => pathExists(wofDatabasePath("admin-global-priority.db"))

/**
 * Builds a held-out row whose spans are the given surfaces, in order, separated as `raw` separates them.
 */
function row(raw: string, country: string, spans: ReadonlyArray<readonly [string, string]>): HeldoutRow {
	const starts: number[] = []
	const ends: number[] = []
	let from = 0

	for (const [surface] of spans) {
		const start = raw.indexOf(surface, from)

		starts.push(start)
		ends.push(start + surface.length)
		from = start + surface.length
	}

	return {
		raw,
		span_starts: starts,
		span_ends: ends,
		span_tags: spans.map(([, tag]) => tag),
		country,
		source: "test",
		source_id: raw,
		group: raw,
	}
}

const ROWS = [
	row("1600 Pennsylvania Ave NW, Washington, DC 20500", "US", [
		["1600", "house_number"],
		["Pennsylvania Ave NW", "street"],
		["Washington", "locality"],
		["DC", "region"],
		["20500", "postcode"],
	]),
	row("350 5th Ave, New York, NY 10118", "US", [
		["350", "house_number"],
		["5th Ave", "street"],
		["New York", "locality"],
		["NY", "region"],
		["10118", "postcode"],
	]),
	row("Paris, France", "FR", [
		["Paris", "locality"],
		["France", "country"],
	]),
	row("Brighton BN1 1AH", "GB", [
		["Brighton", "locality"],
		["BN1 1AH", "postcode"],
	]),
	row("Chicago, IL", "US", [
		["Chicago", "locality"],
		["IL", "region"],
	]),
	row("Berlin", "DE", [["Berlin", "locality"]]),
]

describe.skipIf(!(await weightsPresent()) || !(await gazetteerPresent()))("geocodeHeldoutRows", () => {
	it("gives the same outcome for every row on a worker pool as on the calling thread", async () => {
		const arm: HeldoutArm = { label: "installed", cacheRoot: repoRootPath(), pins: {} }

		const single = await geocodeHeldoutRows(ROWS, arm, { workers: 1 })
		const pooled = await geocodeHeldoutRows(ROWS, arm, { workers: 3 })

		expect(pooled.size).toBe(ROWS.length)
		expect(Object.fromEntries(pooled)).toEqual(Object.fromEntries(single))
	}, 600_000)
})
