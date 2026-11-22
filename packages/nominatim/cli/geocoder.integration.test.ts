// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Nominatim's geocoder answers the parity sample as a geocode session does.
 *
 *   The server's other tests compare the shape of a response.
 *   This one compares the answer: latitude, longitude, resolution tier and country.
 */

// ci-runner: mailwoman-data

import { serverParityDataPresent, serverParityDifferences } from "mailwoman/tools/eval-harness/test-kit/server-parity"
import { describe, expect, it } from "vitest"

import { openNominatimGeocoder } from "#cli/geocoder"

/**
 * The time the two engine builds and the sample's geocodes may take.
 */
const PARITY_TIMEOUT_MS = 600_000

/**
 * The ids of the sampled gauntlet cases the server answers differently from the session today.
 *
 * The server builds its engine by hand and lacks the stages the session gained after it was written.
 * The list empties when the server builds through the session.
 */
const EXPECTED_DIFFERENCES: readonly string[] = [
	"am-thin-system-12",
	"au-street-name-flinders-street",
	"cn-unit-linian",
	"cn-unit-mengding-full",
	"cn-unit-qifenchang",
	"fr-f3-la-croix-rousse-lyon",
	"gh-ws-bank-hospital-block-f6-shippi-close",
	"ni-r7-ballyhackamore-belfast",
	"sb-cs-guadalcanal",
	"us-cross-language-brooklyn-ja-hierarchy",
	"us-landmark-dtw-code-bare",
	"us-opt-geronimo-springs-museum",
	"venue-toponym-comer-bare",
	"vi-op3-red-hook-st-thomas",
]

describe.skipIf(!(await serverParityDataPresent()))("Nominatim's geocoder against the geocode session", () => {
	it(
		"differs from the session on the listed gauntlet cases and on no other",
		async () => {
			const geocoder = await openNominatimGeocoder(null)

			using _rooftops = geocoder.rooftops

			const { differences } = await serverParityDifferences({ server: (input) => geocoder.geocode(input) })

			expect(differences.map(({ id }) => id).toSorted()).toEqual(EXPECTED_DIFFERENCES.toSorted())
		},
		PARITY_TIMEOUT_MS
	)
})
