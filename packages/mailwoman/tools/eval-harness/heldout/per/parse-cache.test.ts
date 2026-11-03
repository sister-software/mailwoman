import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { makeDirectories, writeLocalJSONLFile, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { weightsCachePackageDir } from "@mailwoman/neural/weights"
import { afterAll, describe, expect, it } from "vitest"

import type { HeldoutRow } from "#tools/eval-harness/heldout/per/country"
import { heldoutParseRows, readHeldoutParses, weightsCacheDigest } from "#tools/eval-harness/heldout/per/parse-cache"

const directory = await temporaryDirectory("mw-heldout-parse-cache-")

afterAll(() => directory[Symbol.asyncDispose]())

const row = (source_id: string | null, raw: string): HeldoutRow => ({
	raw,
	span_starts: [0],
	span_ends: [raw.length],
	span_tags: ["locality"],
	country: "DE",
	source: "wof-de",
	source_id,
	group: source_id ?? raw,
})

describe("heldoutParseRows", () => {
	it("identifies two rows without a source_id by their text, so their parses never share a line", () => {
		const parseRows = heldoutParseRows([row(null, "Wollin"), row(null, "Wolgast"), row("a1", "Wollin")])

		expect(new Set(parseRows.map((r) => r.id)).size).toBe(3)
		expect(parseRows[2]).toEqual({ id: "wof-de:a1", raw: "Wollin", country: "DE" })
	})
})

describe("weightsCacheDigest", () => {
	it("changes when a package file changes and covers nested files", async () => {
		const cache = directory.path("cache")
		const usDir = weightsCachePackageDir(cache, "en-us")

		await makeDirectories(usDir("data"))
		await writeLocalTextFile("model-a", usDir("model.onnx"))
		await writeLocalTextFile("lexicon-a", usDir("data", "lexicon.json"))

		const first = await weightsCacheDigest(cache, ["en-us", "en-us"])

		expect(await weightsCacheDigest(cache, ["en-us"])).toBe(first)

		await writeLocalTextFile("lexicon-b", usDir("data", "lexicon.json"))

		expect(await weightsCacheDigest(cache, ["en-us"])).not.toBe(first)
	})

	it("refuses a locale whose package directory holds no files", async () => {
		await expect(weightsCacheDigest(directory.path("cache"), ["de-de"])).rejects.toThrow(
			/neural-weights-de-de holds no files/u
		)
	})
})

describe("readHeldoutParses", () => {
	const parseRows = heldoutParseRows([row("a1", "Wollin"), row("a2", "Wolgast")])

	it("reads every row's spans by identity", async () => {
		const path = directory.path("complete.jsonl").toString()

		await writeLocalJSONLFile(
			[
				{ id: "wof-de:a2", spans: [["locality", 0, 7, "Wolgast"]] },
				{ id: "wof-de:a1", spans: [["locality", 0, 6, "Wollin"]] },
			],
			path
		)

		const parses = await readHeldoutParses(path, parseRows)

		expect(parses.get("wof-de:a1")).toEqual([["locality", 0, 6, "Wollin"]])
	})

	it("refuses a file that lacks a row, repeats a row, or holds a row the dataset lacks", async () => {
		const short = directory.path("short.jsonl").toString()
		const repeated = directory.path("repeated.jsonl").toString()
		const extra = directory.path("extra.jsonl").toString()
		const a1 = { id: "wof-de:a1", spans: [] }
		const a2 = { id: "wof-de:a2", spans: [] }

		await writeLocalJSONLFile([a1], short)
		await writeLocalJSONLFile([a1, a1, a2], repeated)
		await writeLocalJSONLFile([a1, a2, { id: "wof-de:a3", spans: [] }], extra)

		await expect(readHeldoutParses(short, parseRows)).rejects.toThrow(/lacks 1 of 2 rows, first wof-de:a2/u)
		await expect(readHeldoutParses(repeated, parseRows)).rejects.toThrow(/holds row wof-de:a1 twice/u)
		await expect(readHeldoutParses(extra, parseRows)).rejects.toThrow(/holds 3 rows; the dataset holds 2/u)
	})
})
