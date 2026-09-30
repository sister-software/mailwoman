/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The board id is content-addressed over sorted `id`+`input`, so reorganizing rows into per-country
 *   files does not move it and artifacts measured before and after stay comparable.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalFile } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/json"
import type { PathBuilder } from "path-ts"
import { afterAll, describe, expect, it } from "vitest"

import { ablationBoardID } from "#tools/eval-harness/gauntlet/ablation"
import { CorpusRowError, loadRegressionCases, regressionCorpusHash } from "#tools/eval-harness/gauntlet/cases/load"
import { canonicalizeSeedCase, SeedCaseSchema } from "#tools/eval-harness/gauntlet/cases/seed-case"

const fixtures = new AsyncDisposableStack()

afterAll(() => fixtures.disposeAsync())

const CORPUS_SIZE = 1029

/**
 * The hash covers the whole canonical row including `note`, and it also lives in every built
 * `regression.db` as the `gauntlet_meta` stamp, so any corpus edit requires a re-pin and a rebuild.
 */
const CORPUS_HASH = "73038d2b417d33aa963abd21726c7a55edfbfbb2e66efa7ab777c4020f0df031"

/**
 * The id is content-addressed rather than order-addressed, so it holds across file
 * reorganization but moves when rows are added or removed.
 */
const BOARD_ID = "gauntlet-regression@1029:3738dde391ac"

const SAMPLE = {
	id: "xx-sample",
	input: "1 Test Street",
	source: "manual",
	addressKind: "test",
	country: "XX",
	status: "pass",
	addedAt: "2026-08-05",
}

async function scratchCorpus(files: Record<string, string>): Promise<PathBuilder> {
	const root = fixtures.use(await temporaryDirectory("gauntlet-cases-")).path

	for (const [relative, body] of Object.entries(files)) {
		await writeLocalFile(body, root(relative))
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
		// A typo'd `expectLon` that parses as "coordinate not asserted" still runs
		// and passes while asserting half the row.
		// That is what the strictness is for.
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

	it("accepts the per-component rendering interface (#34)", () => {
		const rendering = { venue: ["Gandantegchinlen Monastery", "Гандантэгчинлэн хийд"] }

		expect(SeedCaseSchema.safeParse({ ...SAMPLE, expectComponentRenderings: rendering }).success).toBe(true)
	})

	it("rejects a rendering value that is not a string array", () => {
		// The `expectComponents` shape filed under the wrong key — the likeliest authoring slip.
		expect(SeedCaseSchema.safeParse({ ...SAMPLE, expectComponentRenderings: { venue: "хийд" } }).success).toBe(false)
		expect(SeedCaseSchema.safeParse({ ...SAMPLE, expectComponentRenderings: { venue: [42] } }).success).toBe(false)
		expect(SeedCaseSchema.safeParse({ ...SAMPLE, expectComponentRenderings: ["хийд"] }).success).toBe(false)
	})

	it("rejects an empty rendering list — it would assert nothing while looking asserted", () => {
		expect(SeedCaseSchema.safeParse({ ...SAMPLE, expectComponentRenderings: { venue: [] } }).success).toBe(false)
		expect(SeedCaseSchema.safeParse({ ...SAMPLE, expectComponentRenderings: { venue: [""] } }).success).toBe(false)
	})
})

describe("a malformed row names its file and line", () => {
	it("on invalid JSON", async () => {
		const root = scratchCorpus({
			"xx/regression.jsonl": `${stringifyJSON(SAMPLE)}\n{ not json\n`,
		})

		await expect(loadRegressionCases(await root)).rejects.toThrow(/regression\.jsonl:2 — not valid JSON/)
	})

	it("on a schema violation, naming the field", async () => {
		const root = scratchCorpus({
			"xx/regression.jsonl": `${stringifyJSON({ ...SAMPLE, expectLat: "48.8" })}\n`,
		})

		await expect(loadRegressionCases(await root)).rejects.toThrow(/regression\.jsonl:1 — .*expectLat/)
	})

	it("on a malformed rendering interface, naming the field", async () => {
		const root = scratchCorpus({
			"xx/regression.jsonl": `${stringifyJSON({ ...SAMPLE, expectComponentRenderings: { venue: "хийд" } })}\n`,
		})

		await expect(loadRegressionCases(await root)).rejects.toThrow(/regression\.jsonl:1 — .*expectComponentRenderings/)
	})

	it("counts blank lines, so the number matches the editor's", async () => {
		const root = scratchCorpus({
			"xx/regression.jsonl": `${stringifyJSON(SAMPLE)}\n\n\n{ not json\n`,
		})

		await expect(loadRegressionCases(await root)).rejects.toThrow(CorpusRowError)
		await expect(loadRegressionCases(await root)).rejects.toThrow(/regression\.jsonl:4/)
	})

	it("on a country that disagrees with its directory", async () => {
		const root = scratchCorpus({
			"xx/regression.jsonl": `${stringifyJSON({ ...SAMPLE, country: "FR" })}\n`,
		})

		await expect(loadRegressionCases(await root)).rejects.toThrow(/does not match its directory "xx"/)
	})

	it("on a duplicate id across two files in the same dir", async () => {
		const root = scratchCorpus({
			"xx/regression.jsonl": `${stringifyJSON(SAMPLE)}\n`,
			"xx/extra.jsonl": `${stringifyJSON(SAMPLE)}\n`,
		})

		await expect(loadRegressionCases(await root)).rejects.toThrow(/duplicate case id "xx-sample"/)
	})
})
