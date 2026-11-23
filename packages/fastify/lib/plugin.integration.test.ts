// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The plugin's geocode decorator answers the parity sample as a geocode session does,
 *   and a registration without a gazetteer parses from the weights and reads zero data root.
 *
 *   The plugin's other tests inject a fixed pipeline and compare the shape of a response.
 *   These let the plugin build its own engine and compare the answer: latitude,
 *   longitude, resolution tier and country.
 */

// ci-runner: mailwoman-data

import Fastify from "fastify"
import { existingWOFDatabasePaths } from "mailwoman/engine/resolver-backend"
import { NODE_LAYER_CONTRIBUTIONS } from "mailwoman/services/entry/node"
import { serverParityDataPresent, serverParityDifferences } from "mailwoman/tools/eval-harness/test-kit/server-parity"
import { describe, expect, it, vi } from "vitest"

import { mailwomanFastify } from "#plugin"

/**
 * The time the two engine builds and the sample's geocodes may take.
 */
const PARITY_TIMEOUT_MS = 600_000

describe.skipIf(!(await serverParityDataPresent()))("The Fastify plugin's geocode against the geocode session", () => {
	it(
		"answers every sampled gauntlet case as the session does",
		async () => {
			const [resolveDatabasePath] = await existingWOFDatabasePaths()
			const app = Fastify()

			await app.register(mailwomanFastify, { resolveDatabasePath })
			await app.ready()

			// The plugin composes every layer `mailwoman geocode` composes, so it is compared with a session over them.
			const { differences } = await serverParityDifferences({
				server: (input) => app.mailwoman.geocode(input),
				layers: NODE_LAYER_CONTRIBUTIONS,
			})

			await app.close()

			expect(differences).toEqual([])
		},
		PARITY_TIMEOUT_MS
	)
})

describe("The Fastify plugin registered with zero gazetteer path", () => {
	it("parses from the weights, and geocodes without a coordinate, under a data root that doesn't exist", async () => {
		vi.stubEnv("MAILWOMAN_DATA_ROOT", "/nonexistent/never/mailwoman-data-root")
		vi.stubEnv("MAILWOMAN_CANDIDATE_DB", "")
		vi.stubEnv("MAILWOMAN_WOF_DB", "")

		try {
			const app = Fastify()

			await app.register(mailwomanFastify, {})
			await app.ready()

			const parsed = await app.mailwoman.parse("350 5th Ave, New York, NY 10118")
			const geocoded = await app.mailwoman.geocode("350 5th Ave, New York, NY 10118")

			await app.close()

			expect(parsed.components).toContainEqual({ tag: "postcode", value: "10118" })
			expect(geocoded.components).toMatchObject({ postcode: "10118" })
			expect(geocoded.lat).toBeNull()
			expect(geocoded.lon).toBeNull()
		} finally {
			vi.unstubAllEnvs()
		}
	}, 120_000)
})
