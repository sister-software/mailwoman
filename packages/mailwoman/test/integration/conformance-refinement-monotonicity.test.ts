/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The refinement-monotonicity law against the LIVE pipeline — the leg that actually geocodes, and the only
 *   one that can read a real candidate table.
 *
 *   It lives in `test/integration/` because that is the suite the `mailwoman-data` runner runs, with
 *   `MAILWOMAN_DATA_ROOT` set and the weights materialized; the fast leg is portable by construction and a
 *   data-dependent test placed there would skip its way to green. The guard is the resolver-based
 *   `weightsPresent()` idiom the other integration suites use: ASK THE RESOLVER for the model the loader will
 *   open, never a path literal, because a skip-guard that stops matching does not fail — it skips, and the
 *   suite disappears from the run reporting success.
 *
 *   WHAT THIS LEG ADDS OVER THE FAST ONE. The unit legs prove the instrument reads a candidate table
 *   correctly and that every chain is corpus-attested, both without loading anything. Neither can produce a
 *   candidate table, and the table is the whole subject: the fetch window, the country scope, the hierarchy
 *   path and the `checks` are things the resolver decides at run time, and no synthetic trace can attest what
 *   the shipped walk actually does with them.
 *
 *   THIS LEG CANNOT GO RED ON A KNOWN DEFECT, AND CANNOT GO GREEN ON A BLIND ONE. `runConformanceCommand`
 *   blocks on `status: pass` rows, reports tracked ones without blocking, and removes UNMEASURED rows from the
 *   count the verdict is stated over — so a suite that stops being able to decide anything returns non-zero
 *   rather than reporting a clean run over rows nobody measured.
 *
 *   The suite path is pinned rather than defaulted: a default run covers every committed law, and this file
 *   is the refinement leg.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { pathExists } from "@mailwoman/core/fs/readers"
import { resolveWeights } from "@mailwoman/neural/weights"
import { runConformanceCommand } from "mailwoman/eval-harness/conformance/command"
import { loadConformanceFixtures } from "mailwoman/eval-harness/conformance/fixture"
import {
	auditRefinementSuite,
	REFINEMENT_MONOTONICITY_SUITE_PATH,
} from "mailwoman/eval-harness/conformance/refinement-monotonicity"
import { describe, expect, it } from "vitest"

async function weightsPresent(): Promise<boolean> {
	try {
		// ASK THE RESOLVER — see the module docstring, and `v1-parse-gate.test.ts`, which carries the incident.
		return await pathExists((await resolveWeights({ locale: "en-us" })).modelPath)
	} catch {
		return false
	}
}

const gazetteerPresent = async (): Promise<boolean> =>
	(await pathExists(String(dataRootPath("wof", "admin-global-priority.db")))) &&
	(await pathExists(String(dataRootPath("wof", "postcode-locality-intl.db"))))

describe.skipIf(!(await weightsPresent()) || !(await gazetteerPresent()))(
	"refinement monotonicity — live pipeline",
	() => {
		it("audits the committed suite before anything is geocoded", async () => {
			expect(auditRefinementSuite(await loadConformanceFixtures(REFINEMENT_MONOTONICITY_SUITE_PATH))).toEqual([])
		})

		it("holds on every blocking row, and prints the tracked and unmeasured ones", async () => {
			expect(await runConformanceCommand({ suite: REFINEMENT_MONOTONICITY_SUITE_PATH })).toBe(0)
		}, 900_000)
	}
)
