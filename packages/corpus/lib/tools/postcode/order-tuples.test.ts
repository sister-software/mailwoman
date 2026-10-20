/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalJSONLFile, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { sha256File } from "@mailwoman/core/hash"
import { repoRootPath } from "@mailwoman/core/paths"
import { describe, expect, it } from "vitest"

import { cruiseModuleGraph, moduleGraphHash, reachableModules } from "#build/code-hash"
import { committedCorpusSourceInputs, readParquetRecord } from "#parquet/record"
import { postcodeOrderRecipe } from "#recipes/postcode-order"
import { TEST_REGISTER } from "#test-kit/corpus-recipe"
import {
	writePostcodeOrderParquet,
	postcodeOrderFilterSQL,
	postcodeOrderTupleOf,
	samplePostcodeOrderTuples,
	type PostcodeOrderCorpusRow,
	type PostcodeOrderTuple,
} from "#tools/postcode/order-tuples"

/**
 * A corpus row with spans computed from the component texts, so the offsets match `raw`.
 */
function corpusRow(raw: string, components: Array<[tag: string, text: string]>): PostcodeOrderCorpusRow {
	let from = 0
	const starts: number[] = []
	const ends: number[] = []

	for (const [, text] of components) {
		const start = raw.indexOf(text, from)

		starts.push(start)
		ends.push(start + text.length)
		from = start + text.length
	}

	return {
		raw,
		span_tags: components.map(([tag]) => tag),
		span_starts: starts,
		span_ends: ends,
		country: "it",
		source: "openaddresses",
		source_id: "row-1",
		license: "test license",
	}
}

describe("postcodeOrderTupleOf", () => {
	it("rebuilds the components from the spans and records the street-first order", () => {
		const row = corpusRow("Via del Corso 12, 00186 Roma RM", [
			["street", "Via del Corso"],
			["house_number", "12"],
			["postcode", "00186"],
			["locality", "Roma"],
			["region", "RM"],
		])

		expect(postcodeOrderTupleOf(row)).toEqual({
			house_number: "12",
			street: "Via del Corso",
			locality: "Roma",
			postcode: "00186",
			cc: "IT",
			source: "openaddresses",
			license: "test license",
			streetFirst: true,
			baseSourceID: "row-1",
		})
	})

	it("records a house-number-first source", () => {
		const row = corpusRow("8 Rue de Rivoli 75004 Paris", [
			["house_number", "8"],
			["street", "Rue de Rivoli"],
			["postcode", "75004"],
			["locality", "Paris"],
		])

		expect(postcodeOrderTupleOf(row)?.streetFirst).toBe(false)
	})

	it("yields nothing for a row missing one of the four components", () => {
		const row = corpusRow("Via del Corso 12, Roma", [
			["street", "Via del Corso"],
			["house_number", "12"],
			["locality", "Roma"],
		])

		expect(postcodeOrderTupleOf(row)).toBeNull()
	})

	it("throws on a span triple that is not parallel rather than skipping the row", () => {
		const row = { ...corpusRow("8 Rue", [["house_number", "8"]]), span_ends: [] }

		expect(() => postcodeOrderTupleOf(row)).toThrow(/parallel/)
	})
})

describe("postcodeOrderFilterSQL", () => {
	it("escapes literals and requires all four tags", () => {
		const sql = postcodeOrderFilterSQL(["fr"], ["o'source"])

		expect(sql).toContain("upper(country) IN ('FR')")
		expect(sql).toContain("source IN ('o''source')")
		expect(sql).toContain("list_contains(span_tags, 'postcode')")
	})

	it("refuses an empty country or source set", () => {
		expect(() => postcodeOrderFilterSQL([], ["ban"])).toThrow(/at least one country and one source/)
	})
})

describe("writePostcodeOrderParquet", () => {
	it("writes the recipe's rows through the parquet writer with a record naming its derivation inputs", async () => {
		await using dir = await temporaryDirectory("postcode-order-parquet-")
		const tuples = dir.path("tuples.jsonl")
		const rows = dir.path("rows.jsonl")
		const output = dir.path("data.parquet")

		const tuple = {
			house_number: "12",
			street: "Via del Corso",
			locality: "Roma",
			postcode: "00186",
			cc: "IT",
			source: "openaddresses",
			license: "test license",
			streetFirst: true,
			baseSourceID: "it-1",
		}

		await writeLocalJSONLFile([tuple, tuple], tuples)

		const lines: string[] = []

		await postcodeOrderRecipe.run(
			{ output: "", seed: 7, variants: 1, input: tuples, register: TEST_REGISTER },
			(line) => lines.push(line)
		)

		await writeLocalTextFile(lines, rows)

		const written = await writePostcodeOrderParquet({ rows, tuples, output, seed: 7 })
		const record = await readParquetRecord(output)

		expect(record).toEqual(written)
		expect(record).toMatchObject({ source: "postcode-order-openaddresses", rows: 2 })
		expect(record!.derivation.extractHash).toBe(await sha256File(tuples))

		expect(record!.derivation.config).toEqual({ recipe: "postcode-order", seed: 7, inputSources: ["openaddresses"] })

		// The code hash reaches the placement table through the recipe's import of `country-formats`.
		const graph = await cruiseModuleGraph(
			["packages/corpus/lib/recipes/postcode-order.ts", "packages/corpus/lib/tools/postcode/order-tuples.ts"],
			repoRootPath()
		)

		expect(reachableModules(graph, ["packages/corpus/lib/recipes/postcode-order.ts"]).modules).toContain(
			"packages/postcode/lib/country-formats/data.ts"
		)

		expect(record!.derivation.codeHash).toBe(
			await moduleGraphHash([
				"packages/corpus/lib/recipes/postcode-order.ts",
				"packages/corpus/lib/tools/postcode/order-tuples.ts",
			])
		)

		expect(record!.registerInputs).toEqual(
			(await committedCorpusSourceInputs()).resolve("openaddresses")!.mapping.inputs
		)
	})
})

describe("samplePostcodeOrderTuples", () => {
	const tuple = (cc: string, source: string, locality: string, n: number): PostcodeOrderTuple => ({
		house_number: String(n),
		street: "Main",
		locality,
		postcode: "00000",
		cc,
		source,
		license: "l",
		streetFirst: false,
		baseSourceID: `${cc}-${source}-${locality}-${n}`,
	})

	it("caps each (country, source) pair and spreads the cap across localities", async () => {
		const rows = [
			...Array.from({ length: 10 }, (_, n) => tuple("FR", "ban", "Paris", n)),
			...Array.from({ length: 10 }, (_, n) => tuple("FR", "ban", "Lyon", n)),
			tuple("FR", "ban", "Nice", 0),
			...Array.from({ length: 10 }, (_, n) => tuple("FR", "openaddresses", "Paris", n)),
			...Array.from({ length: 10 }, (_, n) => tuple("IT", "openaddresses", "Roma", n)),
		]

		const kept = await samplePostcodeOrderTuples(rows, { cap: 5, localityQuota: 4 })

		const count = (cc: string, source: string, locality?: string) =>
			kept.filter((t) => t.cc === cc && t.source === source && (!locality || t.locality === locality)).length

		expect(count("FR", "ban")).toBe(5)
		expect(count("FR", "openaddresses")).toBe(4)
		expect(count("IT", "openaddresses")).toBe(4)
		// Every locality is reached before any repeats a third time.
		expect(count("FR", "ban", "Nice")).toBe(1)
		expect(count("FR", "ban", "Paris")).toBe(2)
		expect(count("FR", "ban", "Lyon")).toBe(2)
	})
})
