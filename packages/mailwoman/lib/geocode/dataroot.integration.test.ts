/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   A session's `dataRoot` must govern weights resolution as well as the gazetteer paths.
 *
 *   `createGeocodeSession` resolves gazetteer artifacts under `options.dataRoot`, and weights
 *   resolution is a ladder of which only the overlay rung is governed by `dataRoot`. A bogus root
 *   A real candidate.db passes the gazetteer check.
 *   The session checks the gazetteer first, then checks weights. The bogus root must fail at the weights check.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { pathExists } from "@mailwoman/core/fs/readers"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { wofDatabasePath } from "@mailwoman/resolver-wof-sqlite/paths"
import { afterAll, describe, expect, it } from "vitest"

import { createGeocodeCommandOptions, createGeocodeSession } from "#geocode"

const REAL_CANDIDATE_DB = wofDatabasePath("candidate.db")
const haveArtifacts = await pathExists(REAL_CANDIDATE_DB)

const BOGUS_ROOT = await temporaryDirectory("mw-bogus-root-")

afterAll(() => BOGUS_ROOT[Symbol.asyncDispose]())

describe.skipIf(!haveArtifacts)("createGeocodeSession — dataRoot reaches weights (#1732)", () => {
	it("resolves nothing from the ENV overlay under a bogus dataRoot", async () => {
		// Weights resolution is a ladder.
		// Only its overlay rung is governed by `dataRoot`.
		// A checkout whose workspace packages or weights cache contain binaries
		// (CI links them into its checkout) resolves the FST from those rungs,
		// while a checkout without them rejects outright.
		// Both are in-interface, so this pin asserts that whatever the ladder answers is never a path
		// inside the process env data root's weights overlay when the session was given a different root.
		const session = await createGeocodeSession(
			// The production defaults factory rather than a hand-built literal, the same lockstep factory the
			// dev-mcp registry derives from, so this pin cannot drift from the shipped configuration.
			createGeocodeCommandOptions({
				locale: "en-US",
				dataRoot: BOGUS_ROOT.path.toString(),
				// A real candidate.db keeps the gazetteer check, resolved first, from masking the weights step.
				// The point is to reach weights resolution with the bogus root still in force.
				candidateDB: REAL_CANDIDATE_DB.toString(),
			})
		).then(
			(created) => ({ session: created }),
			(error: unknown) => ({ error })
		)

		if ("error" in session) {
			expect(String(session.error)).toMatch(/neural weights/)

			return
		}

		try {
			const fstPath = session.session.artifacts.fstPath

			if (fstPath) {
				const envOverlay = dataRootPath("weights")

				expect(fstPath.startsWith(envOverlay.toString())).toBe(false)
			}
		} finally {
			session.session[Symbol.dispose]()
		}
	}, 60_000)
})
