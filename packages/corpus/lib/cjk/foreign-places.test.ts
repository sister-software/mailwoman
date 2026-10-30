/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The foreign-place builder routes CJK-script rows of non-CJK countries and follows the split attribute.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/json"
import { pythonSplitWhitespace } from "@mailwoman/core/strings/python-text"
import { describe, expect, it } from "vitest"

import {
	buildForeignPlaces,
	cjkShare,
	type ForeignPlaceRow,
	isForeignCJKRow,
	toForeignPlaceRecord,
	utf16Boundaries,
} from "#cjk/foreign-places"
import { readParquetRows } from "#parquet/readers"
import { ParquetColumnKind, writeColumnParquetFile } from "#parquet/writers"

const COLUMNS = [
	["raw", ParquetColumnKind.String],
	["tokens", ParquetColumnKind.StringList],
	["labels", ParquetColumnKind.StringList],
	["span_starts", ParquetColumnKind.Int32List],
	["span_ends", ParquetColumnKind.Int32List],
	["span_tags", ParquetColumnKind.StringList],
	["country", ParquetColumnKind.String],
	["source_id", ParquetColumnKind.String],
] as const

/**
 * A corpus row with UTF-16 span offsets, as the TypeScript corpus build writes them.
 */
function row(raw: string, country: string, sourceID: string, spans: readonly (readonly [string, string])[]) {
	const starts: number[] = []
	const ends: number[] = []
	let cursor = 0

	for (const [, text] of spans) {
		const start = raw.indexOf(text, cursor)

		starts.push(start)
		ends.push(start + text.length)
		cursor = start + text.length
	}

	const tokens = pythonSplitWhitespace(raw)

	return {
		raw,
		tokens,
		labels: tokens.map(() => "O"),
		span_starts: starts,
		span_ends: ends,
		span_tags: spans.map(([tag]) => tag),
		country,
		source_id: sourceID,
	} satisfies ForeignPlaceRow
}

describe("cjkShare", () => {
	it("reads letters only", () => {
		expect(cjkShare("ニューヨーク州ブルックリン区")).toBe(1)
		expect(cjkShare("フェアモント, WV")).toBeLessThan(0.9)
		expect(cjkShare("12345")).toBe(0)
		// A halfwidth katakana letter is named HALFWIDTH KATAKANA, so it is a letter outside the CJK set.
		expect(cjkShare("ｶﾀ")).toBe(0)
		expect(cjkShare("𠮷野")).toBe(1)
	})

	it("counts no letter that Unicode 15.0 had not assigned, as Python 3.12's isalpha did", () => {
		// U+2EBF0 is CJK Extension I (Unicode 15.1).
		// Python counted the row's two letters, both CJK.
		expect(cjkShare("東京\u{2EBF0}")).toBe(1)
		expect(isForeignCJKRow({ raw: "東京\u{2EBF0}", country: "US" })).toBe(true)
	})

	it("keeps a mixed row and a CJK country's row with their own families", () => {
		expect(isForeignCJKRow({ raw: "ニューヨーク州ブルックリン区", country: "US" })).toBe(true)
		expect(isForeignCJKRow({ raw: "フェアモント, WV", country: "US" })).toBe(false)
		expect(isForeignCJKRow({ raw: "東京都渋谷区", country: "JP" })).toBe(false)
	})
})

describe("toForeignPlaceRecord", () => {
	it("moves UTF-16 offsets to code points", () => {
		const record = toForeignPlaceRecord(row("翼𦑃", "US", "f", [["locality", "翼𦑃"]]))

		expect([record.span_starts, record.span_ends]).toEqual([[0], [2]])
		expect(record.register).toBe("wof-foreign-cjk")
	})

	it("refuses an offset inside a surrogate pair", () => {
		expect(() => utf16Boundaries("翼𦑃", [0, 2])).toThrow("span offsets are not UTF-16 boundaries for '翼𦑃': [2]")
	})
})

describe("buildForeignPlaces", () => {
	it("writes train and val and leaves test rows out", async () => {
		await using scratch = await temporaryDirectory("mailwoman-foreign-places-")
		const parquet = scratch.path("wof-admin.parquet").toString()
		const splitAttribute = scratch.path("wof-admin.split.x.json").toString()
		const outDir = scratch.path("out").toString()

		await writeColumnParquetFile(
			[
				row("ブルックリン区ニューヨークニューヨーク州", "US", "a", [
					["dependent_locality", "ブルックリン区"],
					["locality", "ニューヨーク"],
					["region", "ニューヨーク州"],
				]),
				row("ミュンヘン", "DE", "b", [["locality", "ミュンヘン"]]),
				row("뉴욕 주 브루클린", "US", "c", [
					["region", "뉴욕 주"],
					["dependent_locality", "브루클린"],
				]),
				row("Brooklyn, New York", "US", "d", [
					["dependent_locality", "Brooklyn"],
					["locality", "New York"],
				]),
				row("渋谷区", "JP", "e", [["municipality", "渋谷区"]]),
				row("パリ", "FR", "g", [["farm", "パリ"]]),
			],
			COLUMNS,
			parquet
		)

		await writeLocalTextFile(stringifyJSON({ val: ["b"], test: ["c"] }), splitAttribute)

		const report = await buildForeignPlaces({ parquet, splitAttribute, outDir })

		expect(report.get("rows")).toEqual(
			new Map([
				["train", 1],
				["val", 1],
			])
		)

		expect(report.get("test_rows_left_out")).toBe(1)

		expect(report.get("countries")).toEqual(
			new Map([
				["US", 1],
				["DE", 1],
			])
		)

		expect(report.get("refused")).toEqual(
			new Map([["tag 'farm' is outside stage3-cjk — it would collapse to O at load", 1]])
		)

		const train = await readParquetRows<{ raw: string; register: string }>(`${outDir}/train/wof-admin-0000.parquet`)

		expect(train.map((record) => [record.raw, record.register])).toEqual([
			["ブルックリン区ニューヨークニューヨーク州", "wof-foreign-cjk"],
		])
	})

	it("refuses a missing parquet file, naming its path", async () => {
		await using scratch = await temporaryDirectory("mailwoman-foreign-places-")
		const parquet = scratch.path("absent.parquet").toString()

		await expect(
			buildForeignPlaces({ parquet, splitAttribute: "x", outDir: scratch.path("out").toString() })
		).rejects.toThrow(parquet)
	})

	it("refuses a missing split attribute file, naming its path", async () => {
		await using scratch = await temporaryDirectory("mailwoman-foreign-places-")
		const parquet = scratch.path("wof-admin.parquet").toString()
		const splitAttribute = scratch.path("absent.split.json").toString()

		await writeColumnParquetFile([row("ミュンヘン", "DE", "b", [["locality", "ミュンヘン"]])], COLUMNS, parquet)

		await expect(
			buildForeignPlaces({ parquet, splitAttribute, outDir: scratch.path("out").toString() })
		).rejects.toThrow(splitAttribute)
	})
})
