/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The venue-structure confound board, run as a check.
 *
 *   `venueStructureBiasScale` pushes venue-interior designators ("concourse", "terminal", "gate",
 *   "wing") toward `unit` harder than the postal designators they share a vocabulary with. That
 *   risks false units on surfaces where one of those words appears without being a designator: GB
 *   `-gate` street names, "Gate House" venues, and "Terminal" industrial estates.
 *   It also includes "Wing" as a personal or business name and designators used as street names.
 *
 *   The board is `fixtures/venue-structure-confounds.jsonl`, pre-registered before the change was
 *   measured. Its bar is absolute, zero `unit` emissions, because every row is a surface where a
 *   unit is wrong.
 *
 *   The board runs the path a user runs. `enforceWordConsistency` defaults to off on
 *   `NeuralAddressClassifier` and is switched on by `geocode-core.ts` via
 *   `WORD_CONSISTENCY_SHIP_DEFAULT`, so a board run against the raw classifier would measure an
 *   unhealed decode and report failures no consumer of the shipped pipeline can reach.
 */

import { decodeAsJSON } from "@mailwoman/core/decoder"
import { workspacePath } from "@mailwoman/core/paths"
import { WORD_CONSISTENCY_SHIP_DEFAULT } from "@mailwoman/core/pipeline"
import { NeuralAddressClassifier } from "@mailwoman/neural"
import { JSONSpliterator } from "spliterator"
import { describe, expect, test } from "vitest"

interface ConfoundRow {
	raw: string
	class: string
	must_not: string
	/**
	 * Set when a row is known to fail, carrying the reason.
	 *
	 * The row continues through the test.
	 * The inverted assertion fails if it starts passing, so a stale exemption cannot land silently.
	 */
	xfail?: string
}

const BOARD = workspacePath("mailwoman", "lib", "eval-harness", "fixtures", "venue-structure-confounds.jsonl")

const rows: ConfoundRow[] = await JSONSpliterator.fromAsync<ConfoundRow>(BOARD).toArray()

let classifier: NeuralAddressClassifier | undefined

try {
	classifier = await NeuralAddressClassifier.loadFromWeights({ locale: "en-US" })
} catch {
	// A lean checkout with no materialized weights skips the suite rather than failing it.
	classifier = undefined
}

describe.skipIf(!classifier)("venue-structure confound board", () => {
	test("the board is non-empty and covers every registered confound class", () => {
		expect(rows.length).toBeGreaterThanOrEqual(25)
		expect(new Set(rows.map((r) => r.class)).size).toBeGreaterThanOrEqual(5)
	})

	async function emitted(row: ConfoundRow): Promise<string | undefined> {
		const tree = await classifier!.parse(row.raw, {
			// The shipped configuration, by construction.
			enforceWordConsistency: WORD_CONSISTENCY_SHIP_DEFAULT,
		})

		return (decodeAsJSON(tree) as Record<string, string | undefined>)[row.must_not]
	}

	for (const row of rows.filter((r) => !r.xfail)) {
		test(`[${row.class}] emits no ${row.must_not}: ${row.raw}`, async () => {
			expect(await emitted(row)).toBeUndefined()
		})
	}

	for (const row of rows.filter((r) => r.xfail)) {
		test.fails(`[${row.class}] XFAIL (${row.xfail}): ${row.raw}`, async () => {
			expect(await emitted(row)).toBeUndefined()
		})
	}
})
