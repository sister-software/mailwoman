/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The CJK builder helpers answer what the Python helpers answered on the inputs recorded in
 *   `fixtures/builders/cjk-helpers.json`.
 */

import { readLocalJSONFile, readLocalTextFile } from "@mailwoman/core/fs/readers"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { resolvePackagePath } from "@mailwoman/core/module/resolvers"
import { describe, expect, it } from "vitest"

import {
	buildCharVocab,
	charLabelArrayFromSpans,
	coverageStats,
	muniBucket,
	readLabelSetTags,
	saveCharVocab,
	selectExact,
	verifyCJKRecord,
	waterFill,
} from "#cjk/builder"
import { foldHalfwidthKana, intToKanji, kanjiToInt } from "#cjk/text"
import { JP_PREFECTURE_NAMES, normalizeJPName, normalizeJPNumber, splitJPStreet } from "#jp/text"
import { PyRandom } from "#training/pyrandom"

interface HelperRecord {
	muni_bucket: Record<string, number>
	select_exact: [boolean[], boolean[], number]
	water_fill: number[]
	kanji_to_int: Record<string, number | null>
	int_to_kanji: Record<string, string>
	fold_halfwidth_kana: Record<string, string>
	normalize_name: Record<string, string>
	normalize_number: Record<string, string>
	split_street: Record<string, [string, number | null]>
	jp_prefectures: string[]
	char_vocab_text: string
	coverage_stats: Record<string, unknown> & { per_tag_rows: Record<string, number> }
}

const CJK_HELPERS_RECORD = resolvePackagePath("@mailwoman/corpus", "fixtures", "builders", "cjk-helpers.json")

/**
 * A report value as JSON reads it: a map as an object and a marked Python float as its number.
 */
function plain(value: unknown): unknown {
	if (value instanceof Map) return Object.fromEntries([...value].map(([key, entry]) => [key, plain(entry)]))

	if (Array.isArray(value) || !value || typeof value !== "object") return value

	if ("value" in value) return (value as { value: unknown }).value

	return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, plain(entry)]))
}

describe("the CJK builder helpers", async () => {
	const record = await readLocalJSONFile<HelperRecord>(CJK_HELPERS_RECORD)

	it("bucket a unit as the Python builders did", () => {
		for (const [unit, bucket] of Object.entries(record.muni_bucket)) {
			expect(muniBucket(unit), unit).toBe(bucket)
		}
	})

	it("select exactly, drawing what the Python selector drew", () => {
		const rng = new PyRandom(42)

		expect([...selectExact(10, 3, rng)]).toEqual(record.select_exact[0])
		expect([...selectExact(5, 9, rng)]).toEqual(record.select_exact[1])
		expect(rng.random()).toBe(record.select_exact[2])
	})

	it("water-fill a quota", () => {
		expect([
			waterFill(
				new Map([
					["a", 5],
					["b", 1],
					["c", 10],
				]),
				9
			),
			waterFill(new Map(), 3),
			waterFill(new Map([["a", 2]]), 10),
		]).toEqual(record.water_fill)
	})

	it("read and write Japanese numerals and fold half-width kana", () => {
		for (const [text, value] of Object.entries(record.kanji_to_int)) {
			expect(kanjiToInt(text), text).toBe(value)
		}

		for (const [value, text] of Object.entries(record.int_to_kanji)) {
			expect(intToKanji(Number(value))).toBe(text)
		}

		for (const [text, folded] of Object.entries(record.fold_halfwidth_kana)) {
			expect(foldHalfwidthKana(text)).toBe(folded)
		}
	})

	it("normalize and split Japanese fields", () => {
		for (const [text, value] of Object.entries(record.normalize_name)) {
			expect(normalizeJPName(text)).toBe(value)
		}

		for (const [text, value] of Object.entries(record.normalize_number)) {
			expect(normalizeJPNumber(text)).toBe(value)
		}

		for (const [text, value] of Object.entries(record.split_street)) {
			expect(splitJPStreet(text)).toEqual(value)
		}

		expect([...JP_PREFECTURE_NAMES].toSorted()).toEqual(record.jp_prefectures.toSorted())
	})

	it("write a character vocabulary in code-point order, byte for byte", async () => {
		await using scratch = await temporaryDirectory("mailwoman-cjk-vocab-")
		const path = scratch.path("vocab.json")

		await saveCharVocab(buildCharVocab(["abc𠮷", "ab0", "9a"]), path)

		expect(await readLocalTextFile(path)).toBe(record.char_vocab_text)
	})

	it("report coverage with the Python counts, ordering per_tag_rows by first appearance", () => {
		const stats = coverageStats([
			{
				raw: "〒100-0001 東京都千代田区",
				span_starts: [1, 10, 13],
				span_ends: [9, 13, 17],
				span_tags: ["postcode", "prefecture", "municipality"],
				register: "registry",
			},
			{
				raw: "臺北市大安區",
				span_starts: [0, 3],
				span_ends: [3, 6],
				span_tags: ["region", "subregion"],
				register: "native",
			},
		])

		const observed = plain(stats) as Record<string, unknown>
		const { per_tag_rows: expectedTagRows, ...expected } = record.coverage_stats
		const { per_tag_rows: observedTagRows, ...rest } = observed

		expect(rest).toEqual(expected)
		expect(observedTagRows).toEqual(expectedTagRows)

		expect(Object.keys(observedTagRows as object)).toEqual([
			"postcode",
			"prefecture",
			"municipality",
			"region",
			"subregion",
		])
	})

	it("refuse an overlapping span and a tag outside the label set", async () => {
		const tags = await readLabelSetTags("stage3-cjk")

		expect(() => charLabelArrayFromSpans("abcd", [0, 1], [2, 3], ["region", "street"])).toThrow(/overlap/)

		expect(() =>
			verifyCJKRecord({ raw: "ab", span_starts: [0], span_ends: [2], span_tags: ["building_name_x"] }, tags)
		).toThrow(/outside stage3-cjk/)

		await expect(readLabelSetTags("stage9")).rejects.toThrow(/label-schema\.v1\.json/)
	})
})
