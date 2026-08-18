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
 *   configuration, silently — and the FST v4→v5 battery had no warm-path A/B seam at all.
 *
 *   The discriminating shape: a bogus data root WITH a real candidate.db passes the gazetteer check (which is
 *   deliberately resolved first), so the session's next stop is weights — which must now fail against the bogus root.
 *   Before the fix this test's expectation fails: weights resolve happily from the env root and the session comes up.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { dataRootPath } from "@mailwoman/core/utils"
import { afterAll, describe, expect, it } from "vitest"

import { createGeocodeSession } from "../geocode-session.ts"

const REAL_CANDIDATE_DB = String(dataRootPath("wof", "candidate.db"))
const haveArtifacts = existsSync(REAL_CANDIDATE_DB)

const BOGUS_ROOT = mkdtempSync(join(tmpdir(), "mw-bogus-root-"))

afterAll(() => {
	rmSync(BOGUS_ROOT, { recursive: true, force: true })
})

describe.skipIf(!haveArtifacts)("createGeocodeSession — dataRoot reaches weights (#1732)", () => {
	it("fails weights resolution under a bogus dataRoot instead of silently reading the env root", async () => {
		await expect(
			createGeocodeSession({
				locale: "en-US",
				dataRoot: BOGUS_ROOT,
				// A real candidate.db keeps the gazetteer check (resolved first, by contract) from masking the weights
				// step — the whole point is to reach weights resolution with the bogus root still in force.
				candidateDB: REAL_CANDIDATE_DB,
			})
		).rejects.toThrow(/neural weights/)
	}, 60_000)
})
