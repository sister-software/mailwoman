/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The canonical-form law against the LIVE pipeline — the leg that actually geocodes.
 *
 *   It lives in `test/integration/` because that is the suite the `mailwoman-data` runner runs, with
 *   `MAILWOMAN_DATA_ROOT` set and the weights materialized; the fast leg is portable by construction and a
 *   data-dependent test placed there would skip its way to green. The guard is the resolver-based
 *   `weightsPresent()` idiom the other integration suites use: ASK THE RESOLVER for the model the loader will
 *   open, never a path literal, because a skip-guard that stops matching does not fail — it skips, and the
 *   suite disappears from the run reporting success.
 *
 *   WHAT THIS LEG ADDS OVER THE FAST ONE. `nfc-nfd-suite.test.ts` proves the two forms of every committed base
 *   converge in Stage 1 without loading anything. That is the claim about normalization; this is the claim
 *   about the pipeline, and they are different claims — the tokenizer, the lexicons, the pair indices and the
 *   resolver all read text downstream of Stage 1, and any of them could hold a composed form and not its
 *   decomposition.
 *
 *   THIS LEG CANNOT GO RED ON A KNOWN DEFECT. `runConformanceCommand` blocks on `status: pass` rows and
 *   reports tracked ones without blocking, so a tracked violation is printed in full and does not fail CI —
 *   and a tracked row that starts holding prints a promotion instruction rather than sitting in the list
 *   forever. What it DOES fail on is a new violation on a row that held, or a suite that stopped stating this
 *   law.
 *
 *   The suite path is pinned rather than defaulted: a default run covers every committed law, and this file
 *   is the canonical-form leg.
 */

import { dataRootPath } from "@mailwoman/core/utils"
import { resolveWeights } from "@mailwoman/neural/weights"
import { existsSync } from "@mailwoman/platform/fs"
import { runConformanceCommand } from "mailwoman/eval-harness/conformance/command"
import { loadConformanceFixtures } from "mailwoman/eval-harness/conformance/fixture"
import { auditCanonicalFormSuite, NFC_NFD_SUITE_PATH } from "mailwoman/eval-harness/conformance/nfc-nfd"
import { describe, expect, it } from "vitest"

function weightsPresent(): boolean {
	try {
		// ASK THE RESOLVER — see the module docstring, and `v1-parse-gate.test.ts`, which carries the incident.
		return existsSync(resolveWeights({ locale: "en-us" }).modelPath)
	} catch {
		return false
	}
}

const gazetteerPresent = (): boolean =>
	existsSync(String(dataRootPath("wof", "admin-global-priority.db"))) &&
	existsSync(String(dataRootPath("wof", "postcode-locality-intl.db")))

describe.skipIf(!weightsPresent() || !gazetteerPresent())("canonical-form invariance — live pipeline", () => {
	it("audits the committed suite before anything is geocoded", async () => {
		expect(auditCanonicalFormSuite(await loadConformanceFixtures(NFC_NFD_SUITE_PATH))).toEqual([])
	})

	it("holds on every blocking row, and prints the tracked ones", async () => {
		expect(await runConformanceCommand({ suite: NFC_NFD_SUITE_PATH })).toBe(0)
	}, 900_000)
})
