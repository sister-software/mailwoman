/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import {
	classifyCodepoint,
	classifyToken,
	classifyTokenScript,
	foldInputClass,
	foldInputScripts,
	scriptForCodepoint,
	scriptForRange,
	tokenizeForClass,
} from "@mailwoman/query-shape/character-class"
import { computeQueryShape } from "@mailwoman/query-shape/compute"
import type { ScriptCode, TokenClass } from "@mailwoman/query-shape/types"
import { describe, expect, it } from "vitest"

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
		expect(classifyCodepoint(0x4e_2d)).toBe("cjk") // 中
		expect(classifyCodepoint(0x67_71)).toBe("cjk") // 東
		expect(classifyCodepoint(0xac_00)).toBe("cjk") // 가 (Hangul)
	})

	it("recognizes Cyrillic", () => {
		expect(classifyCodepoint(0x04_1c)).toBe("cyrillic") // М
		expect(classifyCodepoint(0x04_31)).toBe("cyrillic") // б
	})

	it("recognizes Arabic", () => {
		expect(classifyCodepoint(0x06_2f)).toBe("arabic") // د
		expect(classifyCodepoint(0x06_28)).toBe("arabic") // ب
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
		script: "Zyyy",
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
		expect(tokens).toHaveLength(2)
		expect(tokens[0]!.body).toBe("東京")
		expect(tokens[1]!.body).toBe("Tokyo")
	})
})

describe("scriptForCodepoint", () => {
	/**
	 * Unicode's own script property, as the engine reports it. The hand ranges exist for speed — `computeQueryShape`
	 * promises microseconds and runs per keystroke — and this is what keeps them honest as Unicode moves: every codepoint
	 * the table claims is checked against `\p{Script=…}` rather than against a reading of the table.
	 */
	const UNICODE_SCRIPT: ReadonlyArray<[ScriptCode, RegExp]> = [
		["Hira", /\p{Script=Hiragana}/u],
		["Kana", /\p{Script=Katakana}/u],
		["Hang", /\p{Script=Hangul}/u],
		["Hani", /\p{Script=Han}/u],
		["Latn", /\p{Script=Latin}/u],
		["Cyrl", /\p{Script=Cyrillic}/u],
		["Arab", /\p{Script=Arabic}/u],
		["Yiii", /\p{Script=Yi}/u],
	]

	it.each(UNICODE_SCRIPT)("answers %s for every codepoint Unicode assigns to it in our ranges", (code, property) => {
		let checked = 0

		for (let cp = 0; cp <= 0x2_a6_df; cp++) {
			// Surrogates are not characters and `String.fromCodePoint` produces a lone one, which no property matches.
			if (cp >= 0xd8_00 && cp <= 0xdf_ff) continue

			if (scriptForCodepoint(cp) !== code) continue

			checked++

			expect([cp.toString(16), property.test(String.fromCodePoint(cp))]).toEqual([cp.toString(16), true])
		}

		// A claim about zero codepoints passes however wrong the table is.
		expect(checked).toBeGreaterThan(0)
	})

	/**
	 * The converse, and the direction the first version of this suite did not check.
	 *
	 * Asserting only that what we CLAIM is a script really is one stops the table over-claiming and says nothing about
	 * what it misses — and a range cannot express an exception, so a block holding two scripts gets drawn through. Both
	 * of this file's misses were that: `COMMON_RANGES` took `0x3000..0x303f` whole, and Unicode assigns 々 (U+3005) and 〇
	 * (U+3007) inside it to Han; it took `0x3099..0x30a0` whole, and U+309D..309F are Hiragana.
	 *
	 * The allowance is per script rather than global, and each number is a measurement of what is left uncovered rather
	 * than a target. Tightening one is a change with its own evidence; a number that GROWS is a script the table stopped
	 * answering for.
	 */
	const UNCOVERED_ALLOWANCE: Readonly<Record<string, number>> = {
		// Hentaigana, the historic hiragana variants, at U+1B002 and above.
		Hira: 291,
		// Circled and squared katakana words — U+32D0.. and U+3300.., typographic rather than written.
		Kana: 157,
		Hang: 0,
		// Ideographic symbols and punctuation in the supplementary plane, U+16FE2 and U+16FF0..16FF6.
		Hani: 9,
		// IPA extensions, modifier letters and the phonetic blocks.
		Latn: 734,
		Cyrl: 78,
		Arab: 266,
		Yiii: 0,
	}

	it.each(UNICODE_SCRIPT)("misses no more of %s than the allowance records", (code, property) => {
		let uncovered = 0

		for (let cp = 0; cp <= 0x2_a6_df; cp++) {
			if (cp >= 0xd8_00 && cp <= 0xdf_ff) continue

			if (!property.test(String.fromCodePoint(cp))) continue

			if (scriptForCodepoint(cp) !== code) {
				uncovered++
			}
		}

		// Equality rather than a ceiling: a table that covers MORE than recorded is a change someone should state, and
		// the allowance is what says which direction the change went.
		expect([code, uncovered]).toEqual([code, UNCOVERED_ALLOWANCE[code]])
	})

	it("reads the two characters that were drawn through a block boundary", () => {
		// 々 in 代々木 and 佐々木, 〇 in an all-zero ward number, ゝ in a name written with the hiragana iteration mark.
		// Each sat inside a range this file called Common because the BLOCK is mostly common.
		expect(scriptForCodepoint(0x30_05)).toBe("Hani")
		expect(scriptForCodepoint(0x30_07)).toBe("Hani")
		expect(scriptForCodepoint(0x30_9d)).toBe("Hira")
	})

	it("calls a digit, a comma and a prolonged sound mark Common rather than guessing a script", () => {
		// `ー` is the one that mattered: it sits inside the Katakana block, Unicode calls it Common, and reading it off
		// the block made `ブロードウェイ` report a fifth of itself as an unrecognized script.
		expect(scriptForCodepoint(0x39)).toBe("Zyyy")
		expect(scriptForCodepoint(0x2c)).toBe("Zyyy")
		expect(scriptForCodepoint(0x30_fc)).toBe("Zyyy")
		expect(scriptForCodepoint(0x30_fb)).toBe("Zyyy")
	})

	it("says Zzzz for a script it has no ranges for, rather than folding it into a neighbour", () => {
		// Devanagari ग. An address in a script this file does not carry is a script it cannot name, and saying so is
		// what lets a consumer tell that apart from "no script here".
		expect(scriptForCodepoint(0x09_17)).toBe("Zzzz")
	})
})

describe("scriptForRange", () => {
	const CHINESE_UNIT = "逊克二分场四队, HEILONGJIANG, CHINA"

	it("answers per segment, which is not what the whole string answers", () => {
		// The string reads Latin, because the romanized province and country outweigh the Han unit. The unit reads Han.
		// A rule about how to render or route the unit wants the second answer.
		const shape = computeQueryShape(CHINESE_UNIT)

		expect(shape.scripts[0]!.script).toBe("Latn")

		expect(
			shape.segments.map((segment) => scriptForRange(shape.tokenClasses, segment.span.start, segment.span.end))
		).toEqual(["Hani", "Latn", "Latn"])
	})

	it("weighs by codepoints, so one long run is not outvoted by several short ones", () => {
		// Three Latin tokens against one Han run of seven characters, inside a single range.
		const shape = computeQueryShape(CHINESE_UNIT)

		expect(scriptForRange(shape.tokenClasses, 0, CHINESE_UNIT.length)).toBe("Latn")
		expect(scriptForRange(shape.tokenClasses, 0, 7)).toBe("Hani")
	})

	it("abstains on a range carrying no script, rather than borrowing a neighbour's", () => {
		const shape = computeQueryShape("東京都千代田区丸の内1-9-1")
		const houseNumber = shape.tokenClasses.at(-1)!.span

		expect(scriptForRange(shape.tokenClasses, houseNumber.start, houseNumber.end)).toBe("Zyyy")
	})
})

describe("classifyTokenScript", () => {
	it.each([
		["東京都千代田区", "Hani"],
		["ブロードウェイ", "Kana"],
		["ひらがな", "Hira"],
		["서울특별시", "Hang"],
		["Gerrard", "Latn"],
		["Москва", "Cyrl"],
		["10118", "Zyyy"],
		["52-1", "Zyyy"],
	] as const)("reads %s as %s", (text, expected) => {
		expect(classifyTokenScript(text)).toBe(expected)
	})
})

describe("foldInputScripts", () => {
	it("names both scripts of a mixed input, which the character class folds to one word", () => {
		// `foldInputClass` answers `mixed` here, and `mixed` names no script at all — so the Han venue in a London
		// address was invisible to every consumer reading the fold.
		const scripts = foldInputScripts("金龍酒家, 12 Gerrard Street, London WC2H 7JS")

		expect(scripts.map((entry) => entry.script)).toEqual(["Latn", "Hani"])
		expect(scripts[0]!.share).toBeCloseTo(0.86, 2)
		expect(scripts[1]!.share).toBeCloseTo(0.14, 2)
	})

	it("separates Hangul from Han, which the character class cannot", () => {
		// Both answer `characterClass: "cjk"`, and the locale hint answers `ja-JP` for both.
		expect(foldInputScripts("서울특별시 종로구 청운동 52-1")[0]!.script).toBe("Hang")
		expect(foldInputScripts("東京都千代田区丸の内1-9-1")[0]!.script).toBe("Hani")
	})

	it("excludes digits and punctuation from BOTH halves of the share", () => {
		// Otherwise a Japanese address with a postcode reports a lower Han share than the same address without one, and
		// the number measures the punctuation rather than the writing.
		const withPostcode = foldInputScripts("〒100-0005 東京都千代田区")
		const without = foldInputScripts("東京都千代田区")

		expect(withPostcode[0]).toEqual(without[0])
	})

	it("answers an empty list when nothing in the input names a script", () => {
		// A bare postcode is not Latin. It is script-neutral, and an empty list says so where a default would not.
		expect(foldInputScripts("10118")).toEqual([])
	})

	it("ranks by share and sums to one", () => {
		const scripts = foldInputScripts("東京都千代田区丸の内1-9-1")
		const total = scripts.reduce((sum, entry) => sum + entry.share, 0)

		expect(total).toBeCloseTo(1, 10)
		const shares = scripts.map((entry) => entry.share)

		expect(shares).toEqual(shares.toSorted((left, right) => right - left))
	})
})
