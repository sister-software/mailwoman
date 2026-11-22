// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The OGC server's geocoder answers the parity sample as a geocode session over the same layers does.
 *
 *   The server's other tests compare the shape of a response.
 *   This one compares the answer: latitude, longitude, resolution tier and country.
 */

// ci-runner: mailwoman-data

import { serverParityDataPresent, serverParityDifferences } from "mailwoman/tools/eval-harness/test-kit/server-parity"
import { describe, expect, it } from "vitest"

import { openOGCGeocoder } from "#cli/geocoder"

/**
 * The time the two session builds and the sample's geocodes may take.
 */
const PARITY_TIMEOUT_MS = 600_000

describe.skipIf(!(await serverParityDataPresent()))("The OGC server's geocoder against the geocode session", () => {
	it(
		"answers every sampled gauntlet case as the session does",
		async () => {
			const geocoder = await openOGCGeocoder(null)

			await using _session = geocoder.session

			const { differences } = await serverParityDifferences({
				server: (input) => geocoder.geocode(input),
				layers: geocoder.layers,
			})

			expect(differences).toEqual([])
		},
		PARITY_TIMEOUT_MS
	)
})
