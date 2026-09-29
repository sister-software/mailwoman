/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The canonical-form law against the live pipeline — the leg that actually geocodes.
 *
 *   This test belongs in the integration suite, which the `mailwoman-data` runner executes with
 *   `MAILWOMAN_DATA_ROOT` set and weights materialized. The fast suite remains portable without those artifacts.
 *   This data-dependent suite uses the resolver-based `weightsPresent()` guard shared by integration tests.
 *   The guard asks the resolver for the model path the loader will open. It checks the actual resolution path.
 *
 *   The fast `nfc-nfd-suite.test.ts` checks that both forms of every committed base converge in Stage 1.
 *   That test covers normalization. This integration test covers the full pipeline.
 *   The tokenizer and lexicons read text after Stage 1. Pair indices and the resolver do too.
 *   Each stage must handle both composed forms and decomposed forms.
 *
 *   `runConformanceCommand` blocks when a `status: pass` row fails. It reports tracked violations without blocking
 *   and prints each violation in full. When a tracked row starts passing, it prints a promotion instruction.
 *   The command fails on a new violation in a passing row or when the suite stops stating this law.
 *
 *   The suite path is pinned so this file runs the canonical-form leg. A default run covers every committed law.
 */

import { pathExists } from "@mailwoman/core/fs/readers"
import { resolveWeights } from "@mailwoman/neural/weights"
import { wofDatabasePath } from "@mailwoman/resolver-wof-sqlite/paths"
import { describe, expect, it } from "vitest"

import { runConformanceCommand } from "#eval-harness/conformance/command"
import { loadConformanceFixtures } from "#eval-harness/conformance/fixture"
import { auditCanonicalFormSuite, NFC_NFD_SUITE_PATH } from "#eval-harness/conformance/nfc-nfd"

async function weightsPresent(): Promise<boolean> {
	try {
		// Ask the resolver for the model path the loader will open.
		// The module comment describes this guard.
		return await pathExists((await resolveWeights({ locale: "en-us" })).modelPath)
	} catch {
		return false
	}
}

const gazetteerPresent = async (): Promise<boolean> =>
	(await pathExists(wofDatabasePath("admin-global-priority.db"))) &&
	(await pathExists(wofDatabasePath("postcode-locality-intl.db")))

describe.skipIf(!(await weightsPresent()) || !(await gazetteerPresent()))(
	"canonical-form invariance — live pipeline",
	() => {
		it("audits the committed suite before anything is geocoded", async () => {
			expect(auditCanonicalFormSuite(await loadConformanceFixtures(NFC_NFD_SUITE_PATH))).toEqual([])
		})

		it("holds on every blocking row, and prints the tracked ones", async () => {
			expect(await runConformanceCommand({ suite: NFC_NFD_SUITE_PATH })).toBe(0)
		}, 900_000)
	}
)
