/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file What `AddressNode.script` says on the four inputs #2282 was opened with.
 *
 *   The four are not arbitrary: each one is a row class the folded `CharacterClass` answers wrongly, and the assertion
 *   that matters in every case is about a span rather than the input. `金龍酒家, 12 Gerrard Street, London WC2H 7JS` is majority
 *   Latin, so anything reading the input's script cannot find the Han venue — which is the span a router wants.
 *
 *   The trees here are hand-built rather than parsed. A parse needs the ~9 GB database set and an ONNX bundle, and what
 *   is under test is the stamp: given spans and the text they index, which script each one answers. A test that ran the
 *   model would grade the model's tagging too, and fail for the wrong reason whenever that moved.
 */

import type { AddressNode, AddressTree } from "@mailwoman/core/decoder"
import { stampSpanScripts } from "mailwoman/span-script"
import { describe, expect, it } from "vitest"

/**
 * A tree whose spans are given as `[tag, start, end]` into `raw`, so a case
 * reads as the offsets it asserts about.
 */
function treeOf(raw: string, spans: ReadonlyArray<[string, number, number]>): AddressTree {
	return {
		raw,
		roots: spans.map(([tag, start, end]) => ({
			tag,
			value: raw.slice(start, end),
			start,
			end,
			confidence: 1,
			children: [],
		})) as AddressNode[],
	}
}

function scriptsOf(tree: AddressTree): Record<string, string | undefined> {
	return Object.fromEntries(tree.roots.map((node) => [node.tag, node.script]))
}

describe("stampSpanScripts — the script each span is written in", () => {
	it("finds the Han venue inside an input that folds to Latin", () => {
		const raw = "金龍酒家, 12 Gerrard Street, London WC2H 7JS"

		const tree = treeOf(raw, [
			["venue", 0, 4],
			["house_number", 6, 8],
			["street", 9, 23],
			["locality", 25, 31],
			["postcode", 32, 40],
		])

		stampSpanScripts(tree, raw)

		expect(scriptsOf(tree)).toEqual({
			venue: "Hani",
			house_number: "Zyyy",
			street: "Latn",
			locality: "Latn",
			postcode: "Latn",
		})
	})

	it("separates kana from the Latin region beside it", () => {
		const raw = "ブロードウェイ, ニューヨーク, NY 10036"

		const tree = treeOf(raw, [
			["street", 0, 7],
			["locality", 9, 16],
			["region", 18, 20],
			["postcode", 21, 26],
		])

		stampSpanScripts(tree, raw)

		expect(scriptsOf(tree)).toEqual({
			street: "Kana",
			locality: "Kana",
			region: "Latn",
			postcode: "Zyyy",
		})
	})

	it("answers Hang on Korean spans, which the `cjk` class cannot say at all", () => {
		const raw = "서울특별시 종로구 청운동 52-1"

		const tree = treeOf(raw, [
			["region", 0, 5],
			["locality", 6, 9],
			["dependent_locality", 10, 13],
			["house_number", 14, 18],
		])

		stampSpanScripts(tree, raw)

		expect(scriptsOf(tree)).toEqual({
			region: "Hang",
			locality: "Hang",
			dependent_locality: "Hang",
			house_number: "Zyyy",
		})
	})

	it("answers the script that writes MOST of a mixed span, not the first codepoint's", () => {
		// 丸の内 is two Han and one Hiragana, so the span is Hani.
		// Reading the leading codepoint would agree here by accident and disagree on の丸内,
		// which is why the fold is weighted.
		const raw = "東京都千代田区丸の内1-9-1"

		const tree = treeOf(raw, [
			["region", 0, 3],
			["locality", 3, 7],
			["street", 7, 10],
			["house_number", 10, 15],
		])

		stampSpanScripts(tree, raw)

		expect(scriptsOf(tree)).toEqual({
			region: "Hani",
			locality: "Hani",
			street: "Hani",
			house_number: "Zyyy",
		})
	})

	it("stamps children, not only the roots a flat projection would reach", () => {
		const raw = "金龍酒家 12 Gerrard Street"

		const tree: AddressTree = {
			raw,
			roots: [
				{
					tag: "street",
					value: "Gerrard Street",
					start: 8,
					end: 22,
					confidence: 1,
					children: [{ tag: "venue", value: "金龍酒家", start: 0, end: 4, confidence: 1, children: [] }],
				} as AddressNode,
			],
		}

		stampSpanScripts(tree, raw)

		expect(tree.roots[0]!.script).toBe("Latn")
		expect(tree.roots[0]!.children[0]!.script).toBe("Hani")
	})

	it("abstains rather than borrowing a neighbour's script for a digits-only span", () => {
		const raw = "10036"
		const tree = treeOf(raw, [["postcode", 0, 5]])

		stampSpanScripts(tree, raw)

		expect(tree.roots[0]!.script).toBe("Zyyy")
	})
})
