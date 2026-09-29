/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The refinement-monotonicity law runs against the live pipeline. This leg geocodes and reads a real candidate table.
 *
 *   It is an `.integration.test.ts` file because the `mailwoman-data` runner runs that suite with
 *   `MAILWOMAN_DATA_ROOT` set and the weights materialized. The fast suite is portable by construction. A
 *   data-dependent test placed there would skip and report success. The guard uses the resolver-based
 *   `weightsPresent()` idiom from the other integration suites. It asks the resolver for the model the loader
 *   will open. A path literal could stop matching while the suite continued to skip and report success.
 *
 *   This integration leg adds evidence beyond the fast one. The unit legs prove that the instrument reads a
 *   candidate table correctly and that every chain is corpus-attested. They do so without loading data. Neither
 *   unit leg can produce a candidate table. The table is the subject of this test. The resolver decides the
 *   fetch window and country scope at run time. It also decides the hierarchy path and `checks`. A synthetic trace
 *   cannot attest how the shipped walk handles them.
 *
 *   This integration leg cannot report a known defect as passing or a blind row as passing. `runConformanceCommand`
 *   blocks on `status: pass` rows and reports tracked rows without blocking. It removes unmeasured rows from the
 *   verdict's count. A suite that cannot decide any rows returns non-zero instead of reporting a clean run over
 *   unmeasured rows.
 *
 *   The suite path is pinned. A default run covers every committed law. This file runs the refinement leg.
 */

import { pathExists } from "@mailwoman/core/fs/readers"
import { resolveWeights } from "@mailwoman/neural/weights"
import { wofDatabasePath } from "@mailwoman/resolver-wof-sqlite/paths"
import { describe, expect, it } from "vitest"

import { runConformanceCommand } from "#eval-harness/conformance/command"
import { loadConformanceFixtures } from "#eval-harness/conformance/fixture"
import {
	auditRefinementSuite,
	REFINEMENT_MONOTONICITY_SUITE_PATH,
} from "#eval-harness/conformance/refinement-monotonicity"

async function weightsPresent(): Promise<boolean> {
	try {
		// ASK the resolver — see the module docstring and `v1-parse-eval.test.ts`, which records the incident.
		return await pathExists((await resolveWeights({ locale: "en-us" })).modelPath)
	} catch {
		return false
	}
}

const gazetteerPresent = async (): Promise<boolean> =>
	(await pathExists(wofDatabasePath("admin-global-priority.db"))) &&
	(await pathExists(wofDatabasePath("postcode-locality-intl.db")))

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
