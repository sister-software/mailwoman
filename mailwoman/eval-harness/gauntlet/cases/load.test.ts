/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The corpus loader's gate, and the receipt for the 2026-08-05 TS-array → per-country-JSONL migration.
 *
 *   THE MIGRATION PROOF, in two legs. While both representations existed, this suite deep-equalled the
 *   loaded corpus against `REGRESSION_CASES` row for row — see the commit that added `cases/<cc>/*.jsonl`,
 *   where that test is green against both. That commit measured {@linkcode CORPUS_HASH} and
 *   {@linkcode BOARD_ID}; the commit that deleted the array kept the pins and dropped the array leg, so the
 *   content claim outlives the source it was checked against. The deep-equal is in the history, not in prose.
 *
 *   The board id is the load-bearing one. `ablationBoardID` fingerprints a SORTED `id`+`input` list, so it is
 *   content-addressed and NOT order-addressed: reorganizing 192 rows into 29 files is invisible to it, and
 *   every ablation artifact measured before the migration stays comparable to every one measured after.
 *   `gauntlet-regression@192:d753b86005a7` is the same string on both sides. The id is NOT versioned by this
 *   change, deliberately — versioning it would have declared a corpus that did not change to be a new board.
 *
 *   Everything else here is the loader's error surface. A corpus spread across 121 files earns its keep only
 *   if a bad row says WHICH file and WHICH line; a bare `SyntaxError` over 306 rows is a scavenger hunt.
 */

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { ablationBoardID } from "../ablation.ts"
import { CorpusRowError, loadRegressionCases, regressionCorpusHash } from "./load.ts"
import { canonicalizeSeedCase, SeedCaseSchema } from "./seed-case.ts"

/**
 * The corpus today — 306 curated regressions.
 *
 * 192 at the 2026-08-05 JSONL migration, plus the 114 `operator:country-sweep-2026-08-05` promotions (the
 * country-coverage sweep's measured FAILs; see `batch-notes.md`). Country dirs went 29 → 121 in the same batch.
 */
const CORPUS_SIZE = 306

/**
 * `regressionCorpusHash` of the corpus.
 *
 * Changing the corpus changes this. That is the point: an edit to a `.jsonl` row now needs a matching edit here, and
 * the diff says "the corpus changed" rather than "a 3,500-line file changed".
 */
const CORPUS_HASH = "58d44d98bdc67482b1afcda8b797ffec6d82f6f91b77991ffe5f92cda18cbbf2"

/**
 * `ablationBoardID` of the corpus.
 *
 * The id is content-addressed and not order-addressed, which is what carried it UNCHANGED across the 2026-08-05 array →
 * JSONL migration. The country sweep is the opposite kind of change — it adds 114 rows — so this one moves, and it
 * should: the ablation board is genuinely a different board.
 */
const BOARD_ID = "gauntlet-regression@306:ba944d75c9df"

/**
 * A minimal well-formed row, for the error-surface tests to mutate.
 */
const SAMPLE = {
	id: "xx-sample",
	input: "1 Test Street",
	source: "manual",
	addressKind: "test",
	country: "XX",
	status: "pass",
	addedAt: "2026-08-05",
}

/**
 * Write a throwaway corpus tree and return its root.
 */
function scratchCorpus(files: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), "gauntlet-cases-"))

	for (const [relative, body] of Object.entries(files)) {
		const path = join(root, relative)

		mkdirSync(join(path, ".."), { recursive: true })
		writeFileSync(path, body, "utf8")
	}

	return root
}

describe("the committed corpus", () => {
	it("loads every row, in country-dir then id order", async () => {
		const cases = await loadRegressionCases()

		expect(cases).toHaveLength(CORPUS_SIZE)

		const order = cases.map((c) => `${c.country.toLowerCase()}/${c.id}`)

		expect(order).toEqual(order.toSorted())
	})

	it("has the content the pins were measured against", async () => {
		expect(regressionCorpusHash(await loadRegressionCases())).toBe(CORPUS_HASH)
	})

	it("derives the pinned ablation board id", async () => {
		expect(ablationBoardID(await loadRegressionCases())).toBe(BOARD_ID)
	})

	it("assigns every case a unique id", async () => {
		const ids = (await loadRegressionCases()).map((c) => c.id)

		expect(new Set(ids).size).toBe(ids.length)
	})

	it("keys every row in the canonical order, so a diff shows content", async () => {
		for (const c of await loadRegressionCases()) {
			expect(Object.keys(c)).toEqual(Object.keys(canonicalizeSeedCase(c)))
		}
	})
})

describe("the row schema", () => {
	it("rejects an unknown key rather than ignoring it", () => {
		// A typo'd `expectLon` that parsed as "coordinate not asserted" is the failure this strictness is for:
		// the row still runs, still passes, and asserts half of what its author wrote.
		const result = SeedCaseSchema.safeParse({ ...SAMPLE, expectLonn: 2.3 })

		expect(result.success).toBe(false)
	})

	it("rejects a status outside the tracked three", () => {
		expect(SeedCaseSchema.safeParse({ ...SAMPLE, status: "passing" }).success).toBe(false)
	})

	it("rejects a tier outside the resolution ladder", () => {
		expect(SeedCaseSchema.safeParse({ ...SAMPLE, expectTier: "rooftop" }).success).toBe(false)
	})

	it("accepts the optional ablation pin (#1502), unused by the corpus today", () => {
		expect(SeedCaseSchema.safeParse({ ...SAMPLE, ablationExpect: { country: "region" } }).success).toBe(true)
	})
})

describe("a malformed row names its file and line", () => {
	it("on invalid JSON", async () => {
		const root = scratchCorpus({
			"xx/regression.jsonl": `${JSON.stringify(SAMPLE)}\n{ not json\n`,
		})

		await expect(loadRegressionCases(root)).rejects.toThrow(/regression\.jsonl:2 — not valid JSON/)
	})

	it("on a schema violation, naming the field", async () => {
		const root = scratchCorpus({
			"xx/regression.jsonl": `${JSON.stringify({ ...SAMPLE, expectLat: "48.8" })}\n`,
		})

		await expect(loadRegressionCases(root)).rejects.toThrow(/regression\.jsonl:1 — .*expectLat/)
	})

	it("counts blank lines, so the number matches the editor's", async () => {
		const root = scratchCorpus({
			"xx/regression.jsonl": `${JSON.stringify(SAMPLE)}\n\n\n{ not json\n`,
		})

		await expect(loadRegressionCases(root)).rejects.toThrow(CorpusRowError)
		await expect(loadRegressionCases(root)).rejects.toThrow(/regression\.jsonl:4/)
	})

	it("on a country that disagrees with its directory", async () => {
		const root = scratchCorpus({
			"xx/regression.jsonl": `${JSON.stringify({ ...SAMPLE, country: "FR" })}\n`,
		})

		await expect(loadRegressionCases(root)).rejects.toThrow(/does not match its directory "xx"/)
	})

	it("on a duplicate id across two files in the same dir", async () => {
		const root = scratchCorpus({
			"xx/regression.jsonl": `${JSON.stringify(SAMPLE)}\n`,
			"xx/extra.jsonl": `${JSON.stringify(SAMPLE)}\n`,
		})

		await expect(loadRegressionCases(root)).rejects.toThrow(/duplicate case id "xx-sample"/)
	})
})
