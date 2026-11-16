// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import type { BCP47 } from "@mailwoman/registry/types"
import { describe, expect, it } from "vitest"

import { classifyCodepoint, classifyToken, classifyTokenScript, scriptForRange } from "#charset"
import { createRecognizer } from "#index"
import { structure } from "#structure"
import { readFrozenFixture } from "#tools/frozen"

const recognizer = createRecognizer([structure])

describe("classifyCodepoint", () => {
	it("recognizes ASCII digits and letters", () => {
		for (let cp = 0x30; cp <= 0x39; cp++) {
			expect(classifyCodepoint(cp)).toBe("digit")
		}

		expect(classifyCodepoint(0x41)).toBe("alpha")
		expect(classifyCodepoint(0x7a)).toBe("alpha")
		expect(classifyCodepoint(0xe9)).toBe("alpha")
	})

	it("recognizes white space, punctuation and connectors as three distinct classes", () => {
		expect(classifyCodepoint(0x20)).toBe("whitespace")
		expect(classifyCodepoint(0x2c)).toBe("punct")
		expect(classifyCodepoint(0x2d)).toBe("connector")
		expect(classifyCodepoint(0x27)).toBe("connector")
	})

	it("recognizes CJK, Cyrillic and Arabic", () => {
		expect(classifyCodepoint(0x4e_2d)).toBe("cjk")
		expect(classifyCodepoint(0xac_00)).toBe("cjk")
		expect(classifyCodepoint(0x04_1c)).toBe("cyrillic")
		expect(classifyCodepoint(0x06_2f)).toBe("arabic")
	})
})

describe("classifyToken", () => {
	it("classifies the common tokens", () => {
		expect(classifyToken("10118")).toBe("digit")
		expect(classifyToken("Paris")).toBe("alpha")
		expect(classifyToken("221B")).toBe("mixed")
		expect(classifyToken("東京駅")).toBe("cjk")
		expect(classifyToken("Москва")).toBe("cyrillic")
		expect(classifyToken("دبي")).toBe("arabic")
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

	/**
	 * Unicode's own script property, against which every codepoint the hand ranges claim
	 * is checked, so a new Unicode release that reassigns a codepoint fails this test.
	 */
	const UNICODE_SCRIPT: ReadonlyArray<[string, RegExp]> = [
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
			// A lone surrogate matches no Unicode script property.
			if (cp >= 0xd8_00 && cp <= 0xdf_ff) continue

			const character = String.fromCodePoint(cp)

			if ((classifyTokenScript(character) as string) !== code) continue

			checked++

			expect([cp.toString(16), property.test(character)]).toEqual([cp.toString(16), true])
		}

		// A claim about zero codepoints passes however wrong the table is.
		expect(checked).toBeGreaterThan(0)
	})

	/**
	 * Each allowance measures the uncovered remainder for one script.
	 *
	 * A growing value means the table covers fewer codepoints in that script.
	 */
	const UNCOVERED_ALLOWANCE: Readonly<Record<string, number>> = {
		// Hentaigana, the historic hiragana variants, at U+1B002 and above.
		Hira: 291,
		// Circled and squared katakana words, U+32D0.. and U+3300.., typographic rather than written.
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

			const character = String.fromCodePoint(cp)

			if (property.test(character) && (classifyTokenScript(character) as string) !== code) {
				uncovered++
			}
		}

		// Equality rather than a ceiling, so a table that covers more than recorded forces the allowance to be restated.
		expect([code, uncovered]).toEqual([code, UNCOVERED_ALLOWANCE[code]])
	})

	it("calls a digit, a comma and a prolonged sound mark Common rather than guessing a script", () => {
		expect(classifyTokenScript(String.fromCodePoint(0x39))).toBe("Zyyy")
		expect(classifyTokenScript(String.fromCodePoint(0x2c))).toBe("Zyyy")
		expect(classifyTokenScript(String.fromCodePoint(0x30_fc))).toBe("Zyyy")
	})

	it("says Zzzz for a script it has no ranges for", () => {
		expect(classifyTokenScript(String.fromCodePoint(0x09_17))).toBe("Zzzz")
	})
})

describe("scriptForRange", () => {
	const CHINESE_UNIT = "逊克二分场四队, HEILONGJIANG, CHINA"

	it("answers per segment, which is not what the whole string answers", () => {
		const { fields } = recognizer.recognize(CHINESE_UNIT)

		expect(fields.scripts[0]!.script).toBe("Latn")

		expect(
			fields.segments.map((segment) => scriptForRange(fields.tokenClasses, segment.span.start, segment.span.end))
		).toEqual(["Hani", "Latn", "Latn"])
	})

	it("weighs by code units, so one long run is not outvoted by several short ones", () => {
		const { fields } = recognizer.recognize(CHINESE_UNIT)

		expect(scriptForRange(fields.tokenClasses, 0, CHINESE_UNIT.length)).toBe("Latn")
		expect(scriptForRange(fields.tokenClasses, 0, 7)).toBe("Hani")
	})

	it("abstains on a range carrying no script, rather than borrowing a neighbor's", () => {
		const { fields } = recognizer.recognize("東京都千代田区丸の内1-9-1")
		const houseNumber = fields.tokenClasses.at(-1)!.span

		expect(scriptForRange(fields.tokenClasses, houseNumber.start, houseNumber.end)).toBe("Zyyy")
	})
})

describe("the classifiers against the frozen legacy output", () => {
	it("agree with the class and script of every Unicode codepoint that forms a token", async () => {
		const { codepointRuns } = await readFrozenFixture()
		const disagreements: string[] = []

		for (const [first, last, key] of codepointRuns) {
			const [, tokenClass, tokenScript] = key.split("|") as [string, string, BCP47.ScriptCode | undefined]

			// A codepoint without a token has no class to compare.
			if (tokenClass === "none") continue

			for (let cp = first; cp <= last; cp++) {
				const character = String.fromCodePoint(cp)

				if (classifyToken(character) !== tokenClass || classifyTokenScript(character) !== tokenScript) {
					disagreements.push(cp.toString(16))
				}
			}
		}

		expect(disagreements).toEqual([])
	})
})
