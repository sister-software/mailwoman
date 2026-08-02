/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The venue-structure confound board (#1423), run as a gate.
 *
 *   `venueStructureBiasScale` pushes venue-INTERIOR designators ("concourse", "terminal", "gate",
 *   "wing", …) toward `unit` harder than the postal designators they share a vocabulary with. The
 *   risk that buys is false units on surfaces where one of those words appears WITHOUT being a
 *   designator: the GB `-gate` street names, "Gate House" venues, "Terminal" industrial estates,
 *   "Wing" as a personal or business name, and designators used as street names.
 *
 *   The board is `fixtures/venue-structure-confounds.jsonl`, pre-registered before the lever was
 *   measured. Its bar is absolute — zero `unit` emissions — because every row is a surface where a
 *   unit is simply wrong, not one where a unit is merely unlikely.
 *
 *   WHY THIS LIVES HERE AND NOT BESIDE THE CLASSIFIER. It has to run the path a USER runs.
 *   `enforceWordConsistency` defaults to OFF on `NeuralAddressClassifier` (so a bare classifier
 *   decode stays byte-identical) and is switched on by `geocode-core.ts` via
 *   `WORD_CONSISTENCY_SHIP_DEFAULT`. A board run against the raw classifier therefore measures an
 *   UN-HEALED decode, and it will report failures that no consumer of the shipped pipeline can
 *   reach — which is exactly what happened while this lever was being measured: `1 Building Society
 *   Place, Leeds` read `unit="Buil"`, a sub-token fragment, and was written up as a pre-existing
 *   product defect. It is not one. `Building` tokenizes to `B`/`uil`/`ding`, the model labelled
 *   those `B-unit`/`I-unit`/`B-street` — three components inside one word, a sequence no valid parse
 *   can have — and the heal collapses it to `unit="Building"` the moment it is on. The bug was in
 *   the harness, and the fix is to make the gate incapable of choosing the wrong path.
 */

import { readFileSync } from "node:fs"

import { decodeAsJSON } from "@mailwoman/core/decoder"
import { WORD_CONSISTENCY_SHIP_DEFAULT } from "@mailwoman/core/pipeline"
import { repoRootPath } from "@mailwoman/core/utils"
import { NeuralAddressClassifier } from "@mailwoman/neural"
import { describe, expect, test } from "vitest"

interface ConfoundRow {
	raw: string
	class: string
	must_not: string
	/**
	 * Set when a row is KNOWN to fail, carrying the reason. Tracked, not hidden: the row keeps running, and if it ever
	 * starts passing the test fails and says to remove the marker — the gauntlet's xfail discipline, which exists so a
	 * fix can never land silently and leave a stale exemption behind.
	 */
	xfail?: string
}

const BOARD = String(repoRootPath("mailwoman", "eval-harness", "fixtures", "venue-structure-confounds.jsonl"))

const rows: ConfoundRow[] = readFileSync(BOARD, "utf8")
	.split("\n")
	.filter(Boolean)
	.map((line) => JSON.parse(line) as ConfoundRow)

let classifier: NeuralAddressClassifier | undefined

try {
	classifier = await NeuralAddressClassifier.loadFromWeights({ locale: "en-US" })
} catch {
	// Lean checkout with no materialized weights — the suite skips rather than fails, matching the
	// other model-gated suites in this leg.
	classifier = undefined
}

describe.skipIf(!classifier)("venue-structure confound board", () => {
	test("the board is non-empty and covers every registered confound class", () => {
		expect(rows.length).toBeGreaterThanOrEqual(25)
		expect(new Set(rows.map((r) => r.class)).size).toBeGreaterThanOrEqual(5)
	})

	async function emitted(row: ConfoundRow): Promise<string | undefined> {
		const tree = await classifier!.parse(row.raw, {
			// The shipped configuration, by construction — see the module header.
			enforceWordConsistency: WORD_CONSISTENCY_SHIP_DEFAULT,
		})

		return (decodeAsJSON(tree) as Record<string, string | undefined>)[row.must_not]
	}

	for (const row of rows.filter((r) => !r.xfail)) {
		test(`[${row.class}] emits no ${row.must_not}: ${row.raw}`, async () => {
			expect(await emitted(row)).toBeUndefined()
		})
	}

	// `test.fails` inverts the assertion, so a row listed here that starts PASSING turns the suite red — which is the
	// point. An xfail nobody is forced to revisit is just a deleted test with extra steps.
	for (const row of rows.filter((r) => r.xfail)) {
		test.fails(`[${row.class}] XFAIL (${row.xfail}): ${row.raw}`, async () => {
			expect(await emitted(row)).toBeUndefined()
		})
	}
})
