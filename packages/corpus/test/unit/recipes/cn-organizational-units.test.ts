/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file `cn-organizational-units` (#2034) — the issue's own rows, labeled by the suffix grammar: the whole ordinal chain
 *   is one `locality_unit`, the named head is `dependent_locality`, and a row with no chain is skipped rather than
 *   guessed at.
 */

import {
	cnOrganizationalUnitsRecipe,
	labelCNOrganizationalRow,
} from "@mailwoman/corpus/recipes/cn-organizational-units"
import { cjkAwareTokenizer } from "@mailwoman/corpus/utils/tokenize"
import { describe, expect, it } from "vitest"

import { sliceRunner } from "#test-kit/corpus-recipe"

const run = sliceRunner("cn-units", cnOrganizationalUnitsRecipe, 11)

describe("labelCNOrganizationalRow", () => {
	it("labels the farm ladder under a province and a city", () => {
		expect(labelCNOrganizationalRow("云南省临沧市孟定农场三分场二队")).toEqual({
			region: "云南省",
			locality: "临沧市",
			dependent_locality: "孟定农场",
			locality_unit: "三分场二队",
		})
	})

	it("labels a named head, the chain, and a comma-separated Latin tail", () => {
		expect(labelCNOrganizationalRow("赵光三分场二十九队, Heilongjiang, China")).toEqual({
			dependent_locality: "赵光",
			locality_unit: "三分场二十九队",
			region: "Heilongjiang",
			country: "China",
		})
	})

	it("reads a space-separated tail, with and without a country", () => {
		expect(labelCNOrganizationalRow("一分场一队 Hunan China")).toEqual({
			locality_unit: "一分场一队",
			region: "Hunan",
			country: "China",
		})

		expect(labelCNOrganizationalRow("六连 Xinjiang Uyghur")).toEqual({
			locality_unit: "六连",
			region: "Xinjiang Uyghur",
		})

		expect(labelCNOrganizationalRow("四连, Heilongjiang, China")).toEqual({
			locality_unit: "四连",
			region: "Heilongjiang",
			country: "China",
		})
	})

	it("keeps a headquarters marker inside the chain", () => {
		expect(labelCNOrganizationalRow("长水河十五分场场部, HEILONGJIANG")).toEqual({
			dependent_locality: "长水河",
			locality_unit: "十五分场场部",
			region: "HEILONGJIANG",
		})
	})

	it("skips a string whose generics carry no ordinal — a name, not a ladder", () => {
		expect(labelCNOrganizationalRow("苗辽林场 Zhejiang China")).toBeNull()
		expect(labelCNOrganizationalRow("红卫大队 Zhejiang")).toBeNull()
		expect(labelCNOrganizationalRow("淮海农场梁庄分场")).toBeNull()
		// A NAMED team (`机耕队`, the machine-tillage team) under a named brigade: no ordinal, so no chain.
		expect(labelCNOrganizationalRow("胜利大队机耕队, Inner Mongolia")).toBeNull()
	})

	it("skips a string with no Chinese at all", () => {
		expect(labelCNOrganizationalRow("Auf der Sotz 5, Ammeldingen bei Neuerburg")).toBeNull()
	})
})

describe("the recipe", () => {
	it("emits one per-character BIO row per chain-bearing CN string and counts the rest as skipped", async () => {
		const { stats, rows } = await run(
			[
				{ raw: "赵光三分场二十九队, Heilongjiang, China", country: "CN" },
				{ raw: "三分场八队", country: "CN" },
				{ raw: "苗辽林场 Zhejiang China", country: "CN" },
				{ raw: "平林 Tainan City", country: "TW" },
			],
			[]
		)

		expect(stats).toEqual({ emitted: 2, skipped: 2, quarantined: 0 })
		expect(rows).toHaveLength(2)

		const [zhaoguang] = rows

		expect(zhaoguang!.components).toEqual({
			dependent_locality: "赵光",
			locality_unit: "三分场二十九队",
			region: "Heilongjiang",
			country: "China",
		})

		// One token per Han character: the chain is seven characters, so seven labels, B- then I-.
		const unitLabels = zhaoguang!.labels!.filter((label) => label.endsWith("locality_unit"))

		expect(unitLabels).toEqual([
			"B-locality_unit",
			"I-locality_unit",
			"I-locality_unit",
			"I-locality_unit",
			"I-locality_unit",
			"I-locality_unit",
			"I-locality_unit",
		])

		expect(zhaoguang!.labels!.filter((label) => label.endsWith("dependent_locality"))).toEqual([
			"B-dependent_locality",
			"I-dependent_locality",
		])

		expect(zhaoguang!.source).toBe("coarse-placer-cn-units")
	})

	it("emits raw + components rows under --golden", async () => {
		const { rows } = await run([{ raw: "三分场八队", country: "CN" }], [], { golden: true })

		expect(rows).toEqual([
			{ raw: "三分场八队", components: { locality_unit: "三分场八队" }, country: "CN", locale: "zh-CN" },
		])
	})
})

describe("cjkAwareTokenizer", () => {
	it("splits Han runs per character and leaves Latin words whole", () => {
		const tokens = cjkAwareTokenizer()
			.tokenize("赵光三分场, Heilongjiang")
			.map((token) => token.text)

		expect(tokens).toEqual(["赵", "光", "三", "分", "场", "Heilongjiang"])
	})

	it("keeps offsets that slice the source back out", () => {
		const source = "六连 Xinjiang"

		for (const token of cjkAwareTokenizer().tokenize(source)) {
			expect(source.slice(token.start, token.end)).toBe(token.text)
		}
	})
})
