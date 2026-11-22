// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The MCP server's geocode tool answers the parity sample as a geocode session over the same layers does.
 *
 *   The server's other tests compare the shape of a tool result.
 *   This one compares the answer: latitude, longitude, resolution tier and country.
 */

// ci-runner: mailwoman-data

import { GEOCODE_DEFAULT_LOCALE } from "mailwoman/geocode/options"
import { serverParityDataPresent, serverParityDifferences } from "mailwoman/tools/eval-harness/test-kit/server-parity"
import { describe, expect, it } from "vitest"

import { geocodeRunThroughCore, geocodeThroughCore, loadCore } from "#cli/core"

/**
 * The time the two session builds and the sample's geocodes may take.
 */
const PARITY_TIMEOUT_MS = 600_000

describe.skipIf(!(await serverParityDataPresent()))("The MCP server's geocode tool against the geocode session", () => {
	// This case runs first and leaves the shared session open.
	// The parity case disposes it.
	it(
		"states the default locale and the absent country scope it answered under",
		async () => {
			const { applied } = await geocodeRunThroughCore("1001 Boulevard Saint-Laurent, Montréal")

			expect(applied).toEqual({
				locale: { locale: GEOCODE_DEFAULT_LOCALE, source: "default" },
				countryScope: { resolver: null, withheld: null },
			})
		},
		PARITY_TIMEOUT_MS
	)

	it(
		"answers every sampled gauntlet case as the session does",
		async () => {
			const core = await loadCore()

			await using _session = core.session

			const { differences } = await serverParityDifferences({
				server: (input) => geocodeThroughCore(input),
				layers: core.layers,
			})

			expect(differences).toEqual([])
		},
		PARITY_TIMEOUT_MS
	)
})
