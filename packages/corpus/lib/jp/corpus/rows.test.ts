/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The Japanese renderer writes each register as the Python renderer wrote it, and the kana helpers read
 *   readings as the Python ones did. The expected rows were recorded from `countries/jp/corpora/rows.py`.
 */

import { describe, expect, it } from "vitest"

import { availableJPRegisters, renderJPRow } from "#jp/corpus/rows"
import { municipalityKanaLookup, pickKanaStem } from "#jp/kana"

const row = (raw: string, starts: number[], ends: number[], tags: string[]) => ({ raw, starts, ends, tags })

/**
 * `render_row` of 東京都 八王子市 八島町, chōme 2, number 3-16-4, postcode 1920062, spaced,
 * with the country and the hyphen ー, in each register.
 */
const RECORDED = {
	native: row(
		"〒192-0062 日本 東京都 八王子市 八島町二丁目3ー16ー4",
		[1, 10, 13, 17, 22, 25, 28],
		[9, 12, 16, 21, 25, 28, 34],
		["postcode", "country", "prefecture", "municipality", "district", "block", "house_number"]
	),
	arabic_chome: row(
		"〒192-0062 日本 東京都 八王子市 八島町2丁目3ー16ー4",
		[1, 10, 13, 17, 22, 25, 28],
		[9, 12, 16, 21, 25, 28, 34],
		["postcode", "country", "prefecture", "municipality", "district", "block", "house_number"]
	),
	compact_folded: row(
		"〒192-0062 日本 東京都 八王子市 八島町2ー3ー16ー4",
		[1, 10, 13, 17, 22, 25],
		[9, 12, 16, 21, 25, 33],
		["postcode", "country", "prefecture", "municipality", "district", "house_number"]
	),
	designator: row(
		"〒192-0062 日本 東京都 八王子市 八島町二丁目3番16号4",
		[1, 10, 13, 17, 22, 25, 28, 30, 33],
		[9, 12, 16, 21, 25, 28, 30, 33, 34],
		[
			"postcode",
			"country",
			"prefecture",
			"municipality",
			"district",
			"block",
			"sub_block",
			"building_number",
			"house_number",
		]
	),
	kana_municipality: row(
		"〒192-0062 日本 東京都 はちおうじ市 八島町二丁目3ー16ー4",
		[1, 10, 13, 17, 24, 27, 30],
		[9, 12, 16, 23, 27, 30, 36],
		["postcode", "country", "prefecture", "municipality", "district", "block", "house_number"]
	),
}

describe("renderJPRow", () => {
	for (const [register, expected] of Object.entries(RECORDED)) {
		it(`writes the ${register} register as the Python renderer did`, () => {
			const record = renderJPRow({
				prefecture: "東京都",
				municipality: "八王子市",
				district: "八島町",
				chome: 2,
				number: "3-16-4",
				postcode: "1920062",
				register,
				spaced: true,
				country: true,
				hyphen: "ー",
				municipalityKana: "はちおうじ市",
			})

			expect([record.raw, record.span_starts, record.span_ends, record.span_tags]).toEqual([
				expected.raw,
				expected.starts,
				expected.ends,
				expected.tags,
			])

			expect(record.labels).toEqual(["O", "B-country", "B-prefecture", "B-municipality", "B-district"])
		})
	}

	it("writes a rural number with a designator and no block", () => {
		const record = renderJPRow({
			prefecture: "沖縄県",
			municipality: "石垣市",
			district: "字大川",
			chome: null,
			number: "9",
			postcode: null,
			register: "designator",
			spaced: false,
			country: false,
		})

		expect([record.raw, record.span_tags]).toEqual([
			"沖縄県石垣市字大川9番地",
			["prefecture", "municipality", "district", "sub_block"],
		])
	})

	it("refuses the kana register without a reading", () => {
		expect(() =>
			renderJPRow({
				prefecture: "神奈川県",
				municipality: "厚木市",
				district: "中町",
				chome: 2,
				number: "3-16",
				postcode: null,
				register: "kana_municipality",
				spaced: false,
				country: false,
			})
		).toThrow(/municipality_kana/)
	})
})

describe("the JP registers and kana readings", () => {
	it("offer each register only where the row can render it", () => {
		expect(availableJPRegisters(2, "3-16")).toEqual(["native", "arabic_chome", "compact_folded", "designator"])
		expect(availableJPRegisters(null, "556-16")).toEqual(["native", "designator"])
		expect(availableJPRegisters(null, "761乙号-2")).toEqual(["native"])
		expect(availableJPRegisters(2, "362B-2", true)).toEqual(["native", "kana_municipality"])
	})

	it("pick the shortest hiragana stem, less the generic's reading", () => {
		expect(pickKanaStem("厚木市", ["あつぎ", "あつぎし", "厚木", "厚木町"])).toBe("あつぎ")
		expect(pickKanaStem("かすみがうら市", ["かすみがうら"])).toBeNull()
		expect(pickKanaStem("大阪市", ["大阪"])).toBeNull()
		expect(pickKanaStem("鳥取市", ["とっとりし"])).toBe("とっとり")
		expect(pickKanaStem("上市町", ["かみいちまち"])).toBe("かみいち")
	})

	it("retry a lookup without the county prefix", () => {
		const table = new Map([
			["上市町", "かみいち町"],
			["厚木市", "あつぎ市"],
		])

		expect(municipalityKanaLookup(table, "厚木市")).toBe("あつぎ市")
		expect(municipalityKanaLookup(table, "中新川郡上市町")).toBe("かみいち町")
		expect(municipalityKanaLookup(table, "大阪市北区")).toBeNull()
	})
})
