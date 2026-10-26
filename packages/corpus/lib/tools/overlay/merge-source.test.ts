/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file A merge with a per-country cap keeps every country and writes its rows out of record order.
 */

import { describe, expect, it } from "vitest"

import { openCorpusRowStream } from "#parquet/corpus-rows"
import { rowToParquet } from "#parquet/schema"
import { writeParquetFile } from "#parquet/writers"
import { useScratchDir } from "#test-kit"
import { CELL_KEYS, mergeSourceFiles } from "#tools/overlay/merge-source"
import { type LabeledRow, SurfaceOrigin } from "#types"

const scratch = useScratchDir("merge-source")

const labeled = (country: string, index: number, tag: "locality" | "region" = "locality"): LabeledRow => ({
	raw: `Place ${index}`,
	components: { [tag]: `Place ${index}` },
	country,
	source: "wof-admin",
	source_id: `wof-admin-${country}-${tag}-${String(index).padStart(5, "0")}`,
	license: "CC0-1.0",
	register: "whos-on-first",
	surface: SurfaceOrigin.Rendered,
	tokens: ["Place", String(index)],
	labels: [`B-${tag}`, `I-${tag}`],
	span_starts: [0],
	span_ends: [6 + String(index).length],
	span_tags: [tag],
})

const writeCountry = async (country: string, rows: number, regionRows = 0) => {
	const path = scratch.path(`${country}.parquet`)

	await writeParquetFile(
		[
			...Array.from({ length: rows }, (_, index) => rowToParquet(labeled(country, index))),
			...Array.from({ length: regionRows }, (_, index) => rowToParquet(labeled(country, index, "region"))),
		],
		path,
		{ extractHash: "fixture", codeHash: "fixture", config: {} }
	)

	return path
}

describe("mergeSourceFiles with rowsPerCountry", () => {
	it("caps the larger country near the cap, keeps the smaller one whole, and mixes the record order", async () => {
		const inputs = [await writeCountry("US", 4000), await writeCountry("CH", 300)]

		const result = await mergeSourceFiles({ inputs, output: scratch.path("merged.parquet"), rowsPerCountry: 1000 })

		expect(result.byCountry["CH"]).toBe(300)
		expect(result.byCountry["US"]).toBeGreaterThan(850)
		expect(result.byCountry["US"]).toBeLessThan(1150)

		const rows = await Array.fromAsync(openCorpusRowStream(result.outputs[0]!))
		const firstHundred = new Set(rows.slice(0, 100).map((row) => row.country))

		expect(firstHundred).toEqual(new Set(["US", "CH"]))

		const ids = rows.map((row) => row.source_id)

		expect(ids).not.toEqual(ids.toSorted())
	})
})

describe("mergeSourceFiles with a cell floor", () => {
	it("keeps the floor of a rare cell that the per-country fill alone would leave out, and fills the country exactly", async () => {
		const inputs = [await writeCountry("US", 4000, 6)]

		const result = await mergeSourceFiles({
			inputs,
			output: scratch.path("floored.parquet"),
			rowsPerCountry: 100,
			cellFloor: { rows: 5, keys: CELL_KEYS.structure },
		})

		const rows = await Array.fromAsync(openCorpusRowStream(result.outputs[0]!))
		const regionRows = rows.filter((row) => row.labels[0] === "B-region")

		expect(result.byCountry["US"]).toBe(100)
		expect(regionRows.length).toBeGreaterThanOrEqual(5)
		expect(new Set(rows.map((row) => row.source_id)).size).toBe(rows.length)
	})
})
