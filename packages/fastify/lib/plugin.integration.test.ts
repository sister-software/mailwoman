// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The plugin's geocode decorator answers the parity sample as a geocode session does.
 *
 *   The plugin's other tests inject a fixed pipeline and compare the shape of a response.
 *   This one lets the plugin build its own pipeline and compares the answer:
 *   latitude, longitude, resolution tier and country.
 */

// ci-runner: mailwoman-data

import Fastify from "fastify"
import { existingWOFDatabasePaths } from "mailwoman/resolver-backend"
import { serverParityDataPresent, serverParityDifferences } from "mailwoman/tools/eval-harness/test-kit/server-parity"
import { describe, expect, it } from "vitest"

import { mailwomanFastify } from "#plugin"

/**
 * The time the two engine builds and the sample's geocodes may take.
 */
const PARITY_TIMEOUT_MS = 600_000

/**
 * The ids of the sampled gauntlet cases the plugin answers differently from the session today.
 *
 * The plugin builds its pipeline by hand and lacks the stages the session gained after it was written.
 * The list empties when the plugin builds through the session.
 */
const EXPECTED_DIFFERENCES: readonly string[] = [
	"am-thin-system-12",
	"au-street-name-flinders-street",
	"ci-thin-system-15",
	"de-r9-nippes-koeln",
	"fr-lyonnais-3-comma-control",
	"fr-op2-le-colimacon",
	"fr-op4-arabica-paris-le-marais",
	"fr-rue-de-constantinople-homonym",
	"gb-op2-247-lets-go",
	"gb-op2-24n-fitness",
	"gb-vob-bao-soho",
	"gb-vob-chill-since-93-covent-garden",
	"gh-ws-bank-hospital-block-f6-shippi-close",
	"kw-street-name-sheikh-jaber-al-ahmad-al-sabah-causeway",
	"mx-street-name-paseo-de-la-reforma",
	"ni-r7-ballyhackamore-belfast",
	"sb-cs-guadalcanal",
	"us-landmark-dtw-code-bare",
	"us-op-st-peters-lebanon",
	"us-op4-cootie-brown-s-in-bristol",
	"us-op4-donkey-s-place-downtown",
	"us-op4-moms-nothing-fancy-seafood-restaurant-and-more",
	"us-op4-por-que-no",
	"us-op4-somewhere-in-bangkok-thai-restaurant",
	"us-opt-daytona-speedway",
	"us-opt-geronimo-springs-museum",
	"us-opt-holiday-world",
	"us-opt-what-cheer-opera",
	"us-subvenue-googleplex-building",
	"venue-toponym-comer-bare",
]

describe.skipIf(!(await serverParityDataPresent()))("The Fastify plugin's geocode against the geocode session", () => {
	it(
		"differs from the session on the listed gauntlet cases and on no other",
		async () => {
			const [resolveDatabasePath] = await existingWOFDatabasePaths()
			const app = Fastify()

			await app.register(mailwomanFastify, { resolveDatabasePath })
			await app.ready()

			const { differences } = await serverParityDifferences({ server: (input) => app.mailwoman.geocode(input) })

			await app.close()

			expect(differences.map(({ id }) => id).toSorted()).toEqual(EXPECTED_DIFFERENCES.toSorted())
		},
		PARITY_TIMEOUT_MS
	)
})
