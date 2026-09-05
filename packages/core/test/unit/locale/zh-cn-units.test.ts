/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The CN organizational-unit reader (#2034): the rows the issue's census found, read into rungs, and split from
 *   their named heads the way the corpus labeler needs.
 */

import { isCNUnitChain, readCNUnits, splitCNUnitChain } from "@mailwoman/core/locale/zh-cn-units"
import { describe, expect, it } from "vitest"

describe("readCNUnits", () => {
	it("reads the state-farm ladder: sub-farm, then team", () => {
		expect(readCNUnits("三分场八队")).toEqual([
			{ surface: "三分场", rung: "subfarm", ordinal: "三", generic: "分场" },
			{ surface: "八队", rung: "team", ordinal: "八", generic: "队" },
		])
	})

	it("reads the XPCC ladder with a zero inside the regiment number", () => {
		expect(readCNUnits("一零三团七连").map((unit) => [unit.rung, unit.ordinal])).toEqual([
			["regiment", "一零三"],
			["company", "七"],
		])
	})

	it("reads a two-digit ordinal, a brigade, a group, a numbered farm, and a headquarters marker", () => {
		expect(readCNUnits("二十九队")[0]).toMatchObject({ rung: "team", ordinal: "二十九" })
		expect(readCNUnits("四大队")[0]).toMatchObject({ rung: "brigade", generic: "大队" })
		expect(readCNUnits("三组")[0]).toMatchObject({ rung: "group" })
		expect(readCNUnits("八场八队").map((unit) => unit.rung)).toEqual(["farm", "team"])
		expect(readCNUnits("十五分场场部").map((unit) => unit.rung)).toEqual(["subfarm", "headquarters"])
	})

	it("reads the long generics before their tails", () => {
		expect(readCNUnits("四生产队")[0]).toMatchObject({ rung: "team", generic: "生产队" })
		expect(readCNUnits("二生产大队")[0]).toMatchObject({ rung: "brigade", generic: "生产大队" })
	})

	it("accepts Arabic digits", () => {
		expect(readCNUnits("3分场2队").map((unit) => unit.ordinal)).toEqual(["3", "2"])
	})

	it("refuses a span that is not a chain rather than reading part of it", () => {
		expect(isCNUnitChain("孟定农场三分场")).toBe(false)
		expect(() => readCNUnits("孟定农场三分场")).toThrow(/not an organizational-unit chain/u)
		expect(isCNUnitChain("红卫大队")).toBe(false)
	})
})

describe("splitCNUnitChain", () => {
	it("splits the named head from the trailing chain", () => {
		expect(splitCNUnitChain("孟定农场三分场二队")).toEqual({ head: "孟定农场", chain: "三分场二队" })
		expect(splitCNUnitChain("赵光三分场二十九队")).toEqual({ head: "赵光", chain: "三分场二十九队" })
		expect(splitCNUnitChain("新合七队")).toEqual({ head: "新合", chain: "七队" })
	})

	it("reads a run that is nothing but a chain as an empty head", () => {
		expect(splitCNUnitChain("八场八队")).toEqual({ head: "", chain: "八场八队" })
		expect(splitCNUnitChain("六分场七队")).toEqual({ head: "", chain: "六分场七队" })
	})

	it("leaves a name whose generic carries no ordinal whole", () => {
		expect(splitCNUnitChain("红卫大队")).toBeNull()
		expect(splitCNUnitChain("淮海农场梁庄分场")).toBeNull()
		expect(splitCNUnitChain("苗辽林场")).toBeNull()
	})

	it("keeps a headquarters marker inside the chain", () => {
		expect(splitCNUnitChain("长水河十五分场场部")).toEqual({ head: "长水河", chain: "十五分场场部" })
	})
})
