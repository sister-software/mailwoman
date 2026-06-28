/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { classifyCodepoint, classifyToken, foldInputClass, tokenizeForClass } from "./character-class.js"
import type { TokenClass } from "./types.js"

describe("classifyCodepoint", () => {
	it("recognizes ASCII digits", () => {
		for (let cp = 0x30; cp <= 0x39; cp++) {
			expect(classifyCodepoint(cp)).toBe("digit")
		}
	})

	it("recognizes ASCII letters", () => {
		expect(classifyCodepoint(0x41)).toBe("alpha") // A
		expect(classifyCodepoint(0x7a)).toBe("alpha") // z
	})

	it("recognizes Latin-1 letters with diacritics", () => {
		expect(classifyCodepoint(0xe9)).toBe("alpha") // é
		expect(classifyCodepoint(0xc4)).toBe("alpha") // Ä
	})

	it("recognizes whitespace", () => {
		expect(classifyCodepoint(0x20)).toBe("whitespace")
		expect(classifyCodepoint(0x09)).toBe("whitespace")
		expect(classifyCodepoint(0x0a)).toBe("whitespace")
	})

	it("recognizes common punctuation", () => {
		expect(classifyCodepoint(0x2c)).toBe("punct") // ,
		expect(classifyCodepoint(0x2e)).toBe("punct") // .
	})

	it("recognizes connectors as a distinct class", () => {
		expect(classifyCodepoint(0x2d)).toBe("connector") // -
		expect(classifyCodepoint(0x27)).toBe("connector") // '
		expect(classifyCodepoint(0x5f)).toBe("connector") // _
	})

	it("recognizes CJK ranges", () => {
		expect(classifyCodepoint(0x4e2d)).toBe("cjk") // 中
		expect(classifyCodepoint(0x6771)).toBe("cjk") // 東
		expect(classifyCodepoint(0xac00)).toBe("cjk") // 가 (Hangul)
	})

	it("recognizes Cyrillic", () => {
		expect(classifyCodepoint(0x041c)).toBe("cyrillic") // М
		expect(classifyCodepoint(0x0431)).toBe("cyrillic") // б
	})

	it("recognizes Arabic", () => {
		expect(classifyCodepoint(0x062f)).toBe("arabic") // د
		expect(classifyCodepoint(0x0628)).toBe("arabic") // ب
	})
})

describe("classifyToken", () => {
	it("returns 'digit' for all-digit strings", () => {
		expect(classifyToken("10118")).toBe("digit")
		expect(classifyToken("0")).toBe("digit")
	})

	it("returns 'alpha' for all-alpha strings", () => {
		expect(classifyToken("Paris")).toBe("alpha")
		expect(classifyToken("rue")).toBe("alpha")
	})

	it("returns 'mixed' for alphanumeric", () => {
		expect(classifyToken("221B")).toBe("mixed")
		expect(classifyToken("10118-1234")).toBe("digit") // hyphen excluded by tokenizer; standalone test
	})

	it("recognizes CJK tokens", () => {
		expect(classifyToken("東京駅")).toBe("cjk")
		expect(classifyToken("서울")).toBe("cjk")
	})

	it("recognizes Cyrillic tokens", () => {
		expect(classifyToken("Москва")).toBe("cyrillic")
	})

	it("recognizes Arabic tokens", () => {
		expect(classifyToken("دبي")).toBe("arabic")
	})
})

describe("foldInputClass", () => {
	const mkToken = (cls: TokenClass["class"]): TokenClass => ({
		span: { start: 0, end: 1, body: "x" },
		class: cls,
		length: 1,
	})

	it("returns 'numeric' for all-digit tokens", () => {
		expect(foldInputClass([mkToken("digit"), mkToken("digit")])).toBe("numeric")
	})

	it("returns 'alpha' for all-alpha tokens", () => {
		expect(foldInputClass([mkToken("alpha")])).toBe("alpha")
	})

	it("returns 'alphanumeric' when alpha + digit coexist", () => {
		expect(foldInputClass([mkToken("alpha"), mkToken("digit")])).toBe("alphanumeric")
	})

	it("returns 'alphanumeric' when any token is mixed", () => {
		expect(foldInputClass([mkToken("mixed")])).toBe("alphanumeric")
	})

	it("returns 'cjk' for pure CJK input", () => {
		expect(foldInputClass([mkToken("cjk"), mkToken("cjk")])).toBe("cjk")
	})

	it("returns 'mixed' for CJK + Latin", () => {
		expect(foldInputClass([mkToken("cjk"), mkToken("alpha")])).toBe("mixed")
	})

	it("defaults to 'alpha' on empty input", () => {
		expect(foldInputClass([])).toBe("alpha")
	})
})

describe("tokenizeForClass", () => {
	it("splits on whitespace and punctuation", () => {
		const tokens = tokenizeForClass("350 5th Ave, New York")
		expect(tokens.map((t) => t.body)).toEqual(["350", "5th", "Ave", "New", "York"])
	})

	it("preserves character offsets", () => {
		const text = "350 5th Ave"
		const tokens = tokenizeForClass(text)
		expect(tokens[0]).toMatchObject({ start: 0, end: 3, body: "350" })
		expect(tokens[1]).toMatchObject({ start: 4, end: 7, body: "5th" })
		expect(tokens[2]).toMatchObject({ start: 8, end: 11, body: "Ave" })
	})

	it("handles empty input", () => {
		expect(tokenizeForClass("")).toEqual([])
	})

	it("handles all-punctuation input", () => {
		expect(tokenizeForClass(",,,")).toEqual([])
	})

	it("splits on script boundaries (CJK vs Latin)", () => {
		const tokens = tokenizeForClass("東京Tokyo")
		expect(tokens.length).toBe(2)
		expect(tokens[0].body).toBe("東京")
		expect(tokens[1].body).toBe("Tokyo")
	})
})
