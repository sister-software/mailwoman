/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file `split-slice` — the holdout policy applied to an overlay parquet after it was written.
 *
 *   The cases here are the two ways an overlay defeats a holdout. A row whose postcode the policy
 *   names must leave the train split, and a row whose components cannot be read must stop the run
 *   rather than default to train, because defaulting to train is what the policy exists to prevent.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import type { ParquetRow } from "@mailwoman/corpus/parquet/schema"
import { writeParquetFile } from "@mailwoman/corpus/parquet/writers"
import { holdoutComponents, splitOverlaySlice } from "@mailwoman/corpus/tools"
import { join } from "path-ts"
import { afterAll, describe, expect, it } from "vitest"

const root = await temporaryDirectory("mw-split-slice-")

afterAll(() => root[Symbol.asyncDispose]())

/**
 * One GB row whose postcode sits at the end of `raw`, the shape `synth-gb` renders.
 *
 * The span triple is what the splitter reads, so the offsets have to name the real substring:
 * a fixture whose spans point elsewhere would pass against a splitter reading the wrong column.
 */
function gbRow(sourceID: string, street: string, locality: string, postcode: string): ParquetRow {
	const raw = `${street}, ${locality}, ${postcode}`
	const localityStart = street.length + 2
	const postcodeStart = localityStart + locality.length + 2

	return {
		raw,
		tokens: raw.split(" "),
		labels: raw.split(" ").map(() => "O"),
		span_starts: [0, localityStart, postcodeStart],
		span_ends: [street.length, localityStart + locality.length, raw.length],
		span_tags: ["street", "locality", "postcode"],
		country: "GB",
		locale: "en-GB",
		source: "synth-gb",
		source_id: sourceID,
		corpus_version: "0.6.0-test",
		license: "HM Land Registry Price Paid Data",
		register: "hm-land-registry-ppd",
		surface: "composed",
		recipe: "synth-gb",
		base_source_id: null,
	}
}

describe("splitOverlaySlice", () => {
	it("moves a row whose postcode area the GB holdout names out of the train split", async () => {
		const input = join(root.path, "part-gb.parquet")

		await writeParquetFile(
			[
				gbRow("gb-1", "Rock Close", "Camborne", "TR14 7TT"),
				gbRow("gb-2", "Waen Terrace", "Conwy", "LL32 8EA"),
				gbRow("gb-3", "Stubbing Drive", "Hebden Bridge", "HX7 6LS"),
				gbRow("gb-4", "Baker Street", "London", "NW1 6XE"),
				gbRow("gb-5", "Hope Street", "Liverpool", "L1 9BP"),
			],
			input
		)

		const result = await splitOverlaySlice({ input, outputDir: root.path })

		expect(result.rows).toBe(5)
		expect(result.counts.train).toBe(2)
		expect(result.counts.val + result.counts.test).toBe(3)
	})

	it("keeps a Liverpool postcode in train, because `L` is not one of the holdout's prefixes", async () => {
		const input = join(root.path, "part-liverpool.parquet")

		await writeParquetFile([gbRow("gb-6", "Hope Street", "Liverpool", "L1 9BP")], input)

		const result = await splitOverlaySlice({ input, outputDir: root.path })

		expect(result.counts.train).toBe(1)
		expect(result.outputs.val).toBeUndefined()
		expect(result.outputs.test).toBeUndefined()
	})

	it("writes no file for a split that drew no row", async () => {
		const input = join(root.path, "part-london.parquet")

		await writeParquetFile([gbRow("gb-7", "Baker Street", "London", "NW1 6XE")], input)

		const result = await splitOverlaySlice({ input, outputDir: root.path })

		expect(Object.keys(result.outputs)).toEqual(["train"])
	})
})

describe("holdoutComponents", () => {
	it("reads the postcode back out of `raw` at the span the row records", () => {
		const row = gbRow("gb-8", "Rock Close", "Camborne", "TR14 7TT")

		expect(holdoutComponents(row, 0, "fixture")).toEqual({
			locality: "Camborne",
			postcode: "TR14 7TT",
		})
	})

	it("refuses a row carrying no span triple rather than reading it as a row with no postcode", () => {
		// The key is absent rather than set to `undefined`, which is the shape a file written
		// before the span triple existed produces.
		const { span_tags, ...row } = gbRow("gb-9", "Rock Close", "Camborne", "TR14 7TT")

		expect(span_tags).toHaveLength(3)
		expect(() => holdoutComponents(row, 3, "fixture")).toThrow(/row 3/)
	})

	it("refuses a span triple whose three arrays disagree in length", () => {
		const row = { ...gbRow("gb-10", "Rock Close", "Camborne", "TR14 7TT"), span_ends: [1] }

		expect(() => holdoutComponents(row, 4, "fixture")).toThrow(/parallel/)
	})
})
