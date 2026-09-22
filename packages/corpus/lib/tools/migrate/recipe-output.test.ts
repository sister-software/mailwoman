/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { parseJSONStrict, stringifyJSON } from "@mailwoman/core/json"
import { migrateRecipeOutput, surfaceForSource } from "@mailwoman/corpus/tools/migrate-recipe-output"
import { describe, expect, it } from "vitest"

const OLD_ROW = {
	raw: "1 Fake St, Faketown",
	country: "US",
	source: "synth-intersection",
	source_id: "x-1",
	corpus_version: "0.5.0",
	license: "CC0-1.0",
	synth_method: "intersection",
	synth_base_id: null,
}

describe("surfaceForSource", () => {
	it("reads the recipe's own classification", () => {
		expect(surfaceForSource("synth-intersection")).toBe("invented")
		expect(surfaceForSource("synth-affix")).toBe("composed")
	})

	it("refuses a source nobody has classified rather than defaulting", () => {
		// A default would write a guess onto every row of an unclassified output,
		// which is the failure the three columns replaced.
		expect(() => surfaceForSource("synth-unclassified")).toThrow(/No surface recorded/)
	})
})

describe("migrateRecipeOutput", () => {
	it("renames the two columns and states what is known about the register", async () => {
		await using scratch = await temporaryDirectory("mw-migrate-")
		const input = scratch.resolve("old.jsonl")
		const output = scratch.resolve("new.jsonl")
		await writeLocalTextFile(`${stringifyJSON(OLD_ROW)}\n`, input)

		const summary = await migrateRecipeOutput(input, output)
		const row = parseJSONStrict<Record<string, unknown>>((await readLocalTextFile(output)).trim())

		expect(summary.rows).toBe(1)
		expect(summary.alreadyMigrated).toBe(0)
		expect(row.recipe).toBe("intersection")
		expect(row.base_source_id).toBeNull()
		expect(row.surface).toBe("invented")
		// The weaker claim a migrated row carries: the rows are real and their upstream is unrecorded.
		expect(row.register).toBe("mailwoman-derived-tuples")
		// The old spellings are gone rather than carried alongside.
		expect(row.synth_method).toBeUndefined()
		expect(row.synth_base_id).toBeUndefined()
	})

	it("passes a row that already carries a surface through untouched", async () => {
		await using scratch = await temporaryDirectory("mw-migrate-done-")
		const input = scratch.resolve("new-in.jsonl")
		const output = scratch.resolve("new-out.jsonl")
		const current = { ...OLD_ROW, register: "openaddresses", surface: "composed", recipe: "german" }
		await writeLocalTextFile(`${stringifyJSON(current)}\n`, input)

		const summary = await migrateRecipeOutput(input, output)
		const row = parseJSONStrict<Record<string, unknown>>((await readLocalTextFile(output)).trim())

		expect(summary.alreadyMigrated).toBe(1)
		// A half-migrated file converges rather than being rewritten to the weaker register.
		expect(row.register).toBe("openaddresses")
		expect(row.surface).toBe("composed")
	})
})
