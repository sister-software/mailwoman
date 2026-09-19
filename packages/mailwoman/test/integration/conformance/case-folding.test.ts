/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The case-folding law against the live pipeline — the leg that actually geocodes.
 *
 *   It lives in `test/integration/` because that is the suite the `mailwoman-data` runner runs, with
 *   `MAILWOMAN_DATA_ROOT` set and the weights materialized. the fast leg is portable by construction and a
 *   data-dependent test placed there would skip its way to green. The guard is the resolver-based
 *   `weightsPresent()` idiom the other integration suites use: ASK the resolver for the model the loader will
 *   open, never a path literal, because a skip-guard that stops matching does not fail — it skips, and the
 *   suite disappears from the run reporting success.
 *
 *   this LEG cannot GO RED on A known defect. `runConformanceCommand` checks on `status: pass` rows and
 *   reports tracked ones without blocking, so a case-folding violation the pipeline currently has is printed
 *   in full and does not fail CI — and a tracked row that starts holding prints a promotion instruction
 *   rather than sitting in the list forever. What it does fail on is a new violation on a row that held, or
 *   a suite that stopped stating this law, which is the whole point of running it here.
 *
 *   The suite path is pinned rather than defaulted: a default run covers every committed law, and this file
 *   is the case-folding leg.
 *
 *   Cheap enough to belong: measured 6.2 s end to end for 29 rows — two geocodes each plus one engine load.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { pathExists } from "@mailwoman/core/fs/readers"
import { resolveWeights } from "@mailwoman/neural/weights"
import { auditCaseFoldingSuite, CASE_FOLDING_SUITE_PATH } from "mailwoman/eval-harness/conformance/case-folding"
import { runConformanceCommand } from "mailwoman/eval-harness/conformance/command"
import { loadConformanceFixtures } from "mailwoman/eval-harness/conformance/fixture"
import { describe, expect, it } from "vitest"

async function weightsPresent(): Promise<boolean> {
	try {
		// ASK the resolver — see the module docstring, and `v1-parse-eval.test.ts`, which carries the incident.
		return await pathExists((await resolveWeights({ locale: "en-us" })).modelPath)
	} catch {
		return false
	}
}

const gazetteerPresent = async (): Promise<boolean> =>
	(await pathExists(String(dataRootPath("wof", "admin-global-priority.db")))) &&
	(await pathExists(String(dataRootPath("wof", "postcode-locality-intl.db"))))

describe.skipIf(!(await weightsPresent()) || !(await gazetteerPresent()))(
	"case-folding invariance — live pipeline",
	() => {
		it("audits the committed suite before anything is geocoded", async () => {
			expect(auditCaseFoldingSuite(await loadConformanceFixtures(CASE_FOLDING_SUITE_PATH))).toEqual([])
		})

		it("holds on every enforcing row, and prints the tracked ones", async () => {
			expect(await runConformanceCommand({ suite: CASE_FOLDING_SUITE_PATH })).toBe(0)
		}, 600_000)
	}
)
