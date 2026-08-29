/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The stale-artifact reproduction, at fixture scale: build a `regression.db` from corpus state A, move the
 *   corpus to state B, and check that a runner refuses to grade against it.
 *
 *   The real 2026-08-06 incident needed a stale `out/` tree to reach. That is not reproducible in a test — but
 *   the SHAPE is exactly this: the DB says one corpus, the disk says another, and until this stamp existed
 *   nothing in the pipeline could tell them apart.
 */

import { DatabaseClient } from "@mailwoman/core/kysley/client"
import { mkdirSync, mkdtempSync, writeFileSync } from "@mailwoman/platform/fs"
import { tmpdir } from "@mailwoman/platform/os"
import { join } from "@mailwoman/platform/path"
import { DatabaseSync } from "@mailwoman/platform/sqlite"
import { buildRegressionDB } from "mailwoman/eval-harness/gauntlet/build-regression-db"
import { loadRegressionCases } from "mailwoman/eval-harness/gauntlet/cases/load"
import { assertCorpusStampFresh, readCorpusStamp } from "mailwoman/eval-harness/gauntlet/corpus-stamp"
import { createGauntletTable, type GauntletDatabase } from "mailwoman/eval-harness/gauntlet/schema"
import { afterEach, describe, expect, it } from "vitest"

const opened: DatabaseClient<GauntletDatabase>[] = []

afterEach(async () => {
	for (const kdb of opened.splice(0)) {
		await kdb.destroy()
	}
})

function row(id: string, input: string): string {
	return JSON.stringify({
		id,
		input,
		source: "manual",
		addressKind: "test",
		country: "XX",
		status: "pass",
		addedAt: "2026-08-06",
	})
}

/**
 * Write a throwaway corpus tree (one `xx/regression.jsonl`) and return its root.
 */
function scratchCorpus(...rows: string[]): string {
	const root = mkdtempSync(join(tmpdir(), "gauntlet-stamp-"))

	mkdirSync(join(root, "xx"), { recursive: true })
	writeFileSync(join(root, "xx", "regression.jsonl"), `${rows.join("\n")}\n`, "utf8")

	return root
}

function scratchDB(): string {
	return join(mkdtempSync(join(tmpdir(), "gauntlet-db-")), "regression.db")
}

function open(path: string): DatabaseClient<GauntletDatabase> {
	const kdb = new DatabaseClient<GauntletDatabase>({ database: new DatabaseSync(path, { readOnly: true }) })

	opened.push(kdb)

	return kdb
}

describe("the build stamp", () => {
	it("records the corpus hash and case count the DB was built from", async () => {
		const corpus = scratchCorpus(row("xx-a", "1 Test Street"), row("xx-b", "2 Test Street"))
		const output = scratchDB()

		await buildRegressionDB({ casesDir: corpus, output })

		const stamp = await readCorpusStamp(open(output))

		expect(stamp?.case_count).toBe(2)
		expect(stamp?.corpus_hash).toMatch(/^[0-9a-f]{64}$/)
		expect(Date.parse(stamp!.built_at)).toBeGreaterThan(0)
	})

	it("accepts a DB whose stamp matches the corpus on disk", async () => {
		const corpus = scratchCorpus(row("xx-a", "1 Test Street"))
		const output = scratchDB()

		await buildRegressionDB({ casesDir: corpus, output })

		await expect(assertCorpusStampFresh(open(output), await loadRegressionCases(corpus))).resolves.toBeUndefined()
	})

	it("REFUSES a DB built from corpus state A once the corpus is at state B", async () => {
		const stateA = scratchCorpus(row("xx-a", "1 Test Street"))
		const output = scratchDB()

		await buildRegressionDB({ casesDir: stateA, output })

		// State B: the same tree, one row edited — the shape of an operator fixing an expectation and re-running
		// the gate without rebuilding.
		const stateB = scratchCorpus(row("xx-a", "1 Test Avenue"))
		const kdb = open(output)

		await expect(assertCorpusStampFresh(kdb, await loadRegressionCases(stateB))).rejects.toThrow(
			/built from a DIFFERENT corpus/
		)

		// The diagnosis is the point: both hashes and both counts, plus what to do about it.
		const error = await assertCorpusStampFresh(kdb, await loadRegressionCases(stateB)).catch((caught: Error) => caught)

		expect(error).toBeInstanceOf(Error)
		expect((error as Error).message).toMatch(/db stamp:\s+[0-9a-f]{64} \(1 cases, built /)
		expect((error as Error).message).toMatch(/live corpus:\s+[0-9a-f]{64} \(1 cases\)/)
		expect((error as Error).message).toMatch(/gauntlet-build regression-db/)
	})

	it("REFUSES a DB that predates the stamp entirely", async () => {
		const output = scratchDB()
		const raw = new DatabaseSync(output)
		const writer = new DatabaseClient<GauntletDatabase>({ database: raw })

		// A pre-2026-08-06 artifact: cases, no meta table.
		await createGauntletTable(writer)
		await writer.destroy()

		const corpus = scratchCorpus(row("xx-a", "1 Test Street"))

		await expect(assertCorpusStampFresh(open(output), await loadRegressionCases(corpus))).rejects.toThrow(
			/carries no corpus stamp/
		)
	})
})

describe("the emptiness guard", () => {
	it("refuses to build from a corpus directory with no country dirs", async () => {
		const empty = mkdtempSync(join(tmpdir(), "gauntlet-empty-"))

		await expect(buildRegressionDB({ casesDir: empty, output: scratchDB() })).rejects.toThrow(
			/resolved ZERO cases[\s\S]*refusing to build an empty regression\.db/
		)
	})

	it("names the directory it read, so the diagnosis is not a guess", async () => {
		const empty = mkdtempSync(join(tmpdir(), "gauntlet-empty-"))
		const error = await buildRegressionDB({ casesDir: empty, output: scratchDB() }).catch((caught: Error) => caught)

		expect((error as Error).message).toContain(empty)
		expect((error as Error).message).toMatch(/stale-compiled-tree/)
	})
})
