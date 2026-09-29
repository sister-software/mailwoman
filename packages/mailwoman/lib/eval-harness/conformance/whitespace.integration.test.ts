/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The whitespace law against the live pipeline — the leg that actually geocodes.
 *
 *   It is an `.integration.test.ts` file because that is the suite the `mailwoman-data` runner runs, with
 *   `MAILWOMAN_DATA_ROOT` set and the weights materialized. the fast leg is portable by construction and a
 *   data-dependent test placed there would skip its way to green. The guard is the resolver-based
 *   `weightsPresent()` idiom the other integration suites use: ask the resolver for the model the loader will
 *   open, never a path literal. A skip guard that stops matching does not fail — it skips.
 *   The suite then disappears from the run reporting success.
 *   suite disappears from the run reporting success.
 *
 *   this LEG cannot GO RED on A known defect. `runConformanceCommand` checks on `status: pass` rows and
 *   reports tracked ones without blocking, so the three whitespace violations the pipeline currently has are
 *   printed in full and do not fail CI — and a tracked row that starts holding prints a promotion instruction
 *   rather than sitting in the list forever. What it does fail on is a new violation on a row that held, or a
 *   suite that stopped stating this law.
 *
 *   The suite path is pinned rather than defaulted. A default run covers every committed law. This file
 *   is the whitespace leg. Measured 8.6 s end to end for 64 rows — two geocodes each plus one engine load.
 */

import { pathExists } from "@mailwoman/core/fs/readers"
import { resolveWeights } from "@mailwoman/neural/weights"
import { wofDatabasePath } from "@mailwoman/resolver-wof-sqlite/paths"
import { describe, expect, it } from "vitest"

import { runConformanceCommand } from "#eval-harness/conformance/command"
import { loadConformanceFixtures } from "#eval-harness/conformance/fixture"
import { auditWhitespaceSuite, WHITESPACE_SUITE_PATH } from "#eval-harness/conformance/whitespace"

async function weightsPresent(): Promise<boolean> {
	try {
		// Ask the resolver.
		// See the module docstring and `v1-parse-eval.test.ts` for the incident.
		return await pathExists((await resolveWeights({ locale: "en-us" })).modelPath)
	} catch {
		return false
	}
}

const gazetteerPresent = async (): Promise<boolean> =>
	(await pathExists(wofDatabasePath("admin-global-priority.db"))) &&
	(await pathExists(wofDatabasePath("postcode-locality-intl.db")))

describe.skipIf(!(await weightsPresent()) || !(await gazetteerPresent()))(
	"whitespace invariance — live pipeline",
	() => {
		it("audits the committed suite before anything is geocoded", async () => {
			expect(auditWhitespaceSuite(await loadConformanceFixtures(WHITESPACE_SUITE_PATH))).toEqual([])
		})

		it("holds on every enforcing row, and prints the tracked ones", async () => {
			expect(await runConformanceCommand({ suite: WHITESPACE_SUITE_PATH })).toBe(0)
		}, 600_000)
	}
)
