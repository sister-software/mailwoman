// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { createFakeClock } from "@mailwoman/core/api/test-clocks"
import { type StubResult, stubTransport } from "@mailwoman/core/api/test-transport"
import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { silentLogger } from "@mailwoman/core/logging"
import { describe, expect, it } from "vitest"

import { createWikidataClient, type SPARQLResults } from "#tools/fetch/wikidata/subvenue"
import {
	buildClassDescentQuery,
	CLASS_QUERY_BATCH,
	type ClassRoots,
	classifyClasses,
	placeVerdict,
	readClassRoots,
} from "#tools/fetch/wikidata/vital-places/classify"
import { chunked } from "#tools/fetch/wikidata/vital-places/progress"

function descent(pairs: Array<[string, string]>): SPARQLResults {
	return {
		results: {
			bindings: pairs.map(([cls, root]) => ({
				class: { type: "uri", value: `http://www.wikidata.org/entity/${cls}` },
				root: { type: "uri", value: `http://www.wikidata.org/entity/${root}` },
			})),
		},
	}
}

describe("buildClassDescentQuery", () => {
	it("names the batch's classes and every root in one walk", () => {
		expect(buildClassDescentQuery(["Q1440476", "Q515"])).toBe(`SELECT DISTINCT ?class ?root WHERE {
  VALUES ?class { wd:Q1440476 wd:Q515 }
  VALUES ?root { wd:Q2221906 wd:Q618123 wd:Q811979 wd:Q1190554 wd:Q3024240 wd:Q486972 wd:Q56061 wd:Q6256 wd:Q473972 wd:Q839954 wd:Q34442 wd:Q79007 }
  ?class wdt:P279* ?root .
}`)
	})

	it("refuses an empty batch and one over the measured limit", () => {
		expect(() => buildClassDescentQuery([])).toThrow(RangeError)

		expect(() => buildClassDescentQuery(Array.from({ length: CLASS_QUERY_BATCH + 1 }, (_, i) => `Q${i + 1}`))).toThrow(
			RangeError
		)
	})
})

describe("chunked", () => {
	it("fills every batch but the last", () => {
		expect(chunked([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
		expect(chunked([], 2)).toEqual([])
		expect(() => chunked([1], 0)).toThrow(RangeError)
	})
})

describe("readClassRoots", () => {
	it("gives a class the answer never names no roots", () => {
		const roots = readClassRoots(
			["Q1440476", "Q515", "Q178561"],
			descent([
				["Q1440476", "Q811979"],
				["Q178561", "Q1190554"],
			])
		)

		expect(roots).toEqual({ Q1440476: ["Q811979"], Q515: [], Q178561: ["Q1190554"] })
	})

	it("refuses a binding missing a column rather than reading it as unclassified", () => {
		const results = { results: { bindings: [{ class: { type: "uri", value: "x" } }] } } as SPARQLResults

		expect(() => readClassRoots(["Q1"], results)).toThrow(/lacks its class or root column/)
	})
})

describe("placeVerdict", () => {
	const roots: ClassRoots = {
		Q1440476: ["Q811979"],
		Q178561: ["Q1190554"],
		Q515: [],
	}

	it("places an item whose class descends from a place root", () => {
		expect(placeVerdict(["Q1440476"], roots)).toBe("place")
	})

	it("lets an excluded root win over a place root", () => {
		expect(placeVerdict(["Q1440476", "Q178561"], roots)).toBe("excluded")
	})

	it("keeps a built class that also descends from occurrence, as mausoleum does", () => {
		expect(placeVerdict(["Q162875"], { Q162875: ["Q811979", "Q618123", "Q2221906", "Q1190554"] })).toBe("place")
	})

	it("excludes a historical-country class even when it reaches geographical feature", () => {
		expect(placeVerdict(["Q417175"], { Q417175: ["Q618123", "Q2221906", "Q3024240"] })).toBe("excluded")
	})

	it("leaves an item with no rooted class, or an unknown class, unclassified", () => {
		expect(placeVerdict(["Q515"], roots)).toBe("unclassified")
		expect(placeVerdict(["Q999"], roots)).toBe("unclassified")
		expect(placeVerdict([], roots)).toBe("unclassified")
	})
})

describe("classifyClasses", () => {
	async function stubWDQS(results: StubResult[], cacheDir: string) {
		const transport = stubTransport(results)

		const client = createWikidataClient({
			cacheDir,
			clock: createFakeClock(),
			axios: transport.axios,
			logger: silentLogger(),
		})

		return { client, transport }
	}

	it("queries only the uncached classes, 150 per query, and rewrites the cache after each", async () => {
		await using scratch = await temporaryDirectory("mailwoman-vital-classify-")
		const cachePath = scratch.path("class-roots.json")

		await writeLocalJSONFile({ Q515: ["Q2221906"] } satisfies ClassRoots, cachePath)

		const classes = ["Q515", ...Array.from({ length: CLASS_QUERY_BATCH + 1 }, (_, i) => `Q${i + 1000}`)]

		const { client, transport } = await stubWDQS(
			[{ body: descent([["Q1000", "Q811979"]]) }, { body: descent([["Q1150", "Q1190554"]]) }],
			scratch.path("http-cache").toString()
		)

		await using _client = client
		const lines: string[] = []

		const result = await classifyClasses(client, classes, { cachePath, report: (line) => lines.push(line) })

		expect(transport.calls).toHaveLength(2)
		expect(result.failedClasses).toEqual([])
		expect(result.roots["Q515"]).toEqual(["Q2221906"])
		expect(result.roots["Q1000"]).toEqual(["Q811979"])
		expect(result.roots["Q1150"]).toEqual(["Q1190554"])
		expect(result.roots["Q1001"]).toEqual([])
		expect(Object.keys(result.roots)).toHaveLength(classes.length)
		await expect(readLocalJSONFile<ClassRoots>(cachePath)).resolves.toEqual(result.roots)

		expect(lines[0]).toBe("  classes: 152 distinct, 151 uncached, 2 queries")
		expect(lines[1]).toMatch(/^ {2}classes: \[1\/2\] 150 classes: 1 place, 0 excluded, \d+\.\d s$/u)
		expect(lines[2]).toMatch(/^ {2}classes: \[2\/2\] 1 classes: 0 place, 1 excluded, \d+\.\d s$/u)

		const [first] = transport.calls
		const query = new URL(first!).searchParams.get("query")!

		expect(query).toContain(
			`VALUES ?class { ${chunked(classes.slice(1), CLASS_QUERY_BATCH)[0]!
				.map((q) => `wd:${q}`)
				.join(" ")} }`
		)
	})

	it("keeps a failed query's classes out of the cache so a rerun asks again", async () => {
		await using scratch = await temporaryDirectory("mailwoman-vital-classify-failed-")
		const cachePath = scratch.path("class-roots.json")

		const { client } = await stubWDQS(
			[{ status: 500, body: "java.util.concurrent.TimeoutException" }],
			scratch.path("http-cache").toString()
		)

		await using _client = client
		const lines: string[] = []

		const result = await classifyClasses(client, ["Q1", "Q2"], { cachePath, report: (line) => lines.push(line) })

		expect(result.failedClasses).toEqual(["Q1", "Q2"])
		expect(result.roots).toEqual({})
		expect(lines.at(-1)).toMatch(/^ {2}✗ classes: query 1 \(Q1…\): /u)
	})
})
