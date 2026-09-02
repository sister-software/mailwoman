/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The #1732 reach pin: a session's `dataRoot` must govern WEIGHTS resolution, not only the gazetteer paths.
 *
 *   The gap this closes: `createGeocodeSession` resolved gazetteer artifacts under `options.dataRoot` but called
 *   `loadFromWeights({ locale })` bare, so weights (and the per-locale FST inside them) resolved from the process
 *   env's data root regardless of the lever. A dev-mcp engine with `data_root` overridden therefore measured a MIXED
 *   configuration, silently — and the FST v4→v5 battery had no warm-path A/B comparison at all.
 *
 *   The discriminating shape: a bogus data root WITH a real candidate.db passes the gazetteer check (which is
 *   deliberately resolved first), so the session's next stop is weights — which must now fail against the bogus root.
 *   Before the fix this test's expectation fails: weights resolve from the env root and the session comes up.
 */

import { dataRootPath, mailwomanDataRoot } from "@mailwoman/core/data-root"
import { pathExists } from "@mailwoman/core/fs/readers"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { createGeocodeCommandOptions, createGeocodeSession } from "mailwoman/geocode"
import { join } from "path-ts"
import { afterAll, describe, expect, it } from "vitest"

const REAL_CANDIDATE_DB = String(dataRootPath("wof", "candidate.db"))
const haveArtifacts = await pathExists(REAL_CANDIDATE_DB)

const BOGUS_ROOT = await temporaryDirectory("mw-bogus-root-")

afterAll(() => BOGUS_ROOT[Symbol.asyncDispose]())

describe.skipIf(!haveArtifacts)("createGeocodeSession — dataRoot reaches weights (#1732)", () => {
	it("resolves nothing from the ENV overlay under a bogus dataRoot", async () => {
		// Weights resolution is a ladder, and only its OVERLAY rung is governed by `dataRoot` — a checkout whose
		// workspace packages or weights cache carry binaries (CI links them into its checkout) resolves the FST from
		// those rungs, while a checkout without them rejects outright. Both are in-contract, so this pin asserts the
		// defect's own words instead: the #1732 bug was weights "silently reading the env root", so whatever the
		// ladder answers, it must never be a path inside the PROCESS ENV data root's weights overlay when the
		// session was given a different root. Pre-fix, `artifacts.fstPath` pointed exactly there.
		const outcome = await createGeocodeSession(
			// The production defaults factory, not a hand-built literal — the same lockstep factory the dev-mcp
			// registry derives from, so this pin cannot drift from the shipped configuration.
			createGeocodeCommandOptions({
				locale: "en-US",
				dataRoot: BOGUS_ROOT.path.toString(),
				// A real candidate.db keeps the gazetteer check (resolved first, by contract) from masking the weights
				// step — the whole point is to reach weights resolution with the bogus root still in force.
				candidateDB: REAL_CANDIDATE_DB,
			})
		).then(
			(session) => ({ session }),
			(error: unknown) => ({ error })
		)

		if ("error" in outcome) {
			expect(String(outcome.error)).toMatch(/neural weights/)

			return
		}

		try {
			const fstPath = outcome.session.artifacts.fstPath

			if (fstPath !== undefined) {
				const envOverlay = join(String(mailwomanDataRoot()), "weights")

				expect(fstPath.startsWith(envOverlay)).toBe(false)
			}
		} finally {
			outcome.session[Symbol.dispose]()
		}
	}, 60_000)
})
