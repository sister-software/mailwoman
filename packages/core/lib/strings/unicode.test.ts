/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Tests the Unicode character classes and splits.
 */

import { expect, test } from "vitest"

import {
	capitalize,
	isDecimalDigits,
	isLetter,
	isWhitespaceCharacter,
	splitLines,
	splitWhitespace,
} from "#strings/unicode"

test("a decimal digit in any script counts, and a superscript or circled digit does not", () => {
	expect(isDecimalDigits("110")).toBe(true)
	expect(isDecimalDigits("１１０")).toBe(true)
	expect(isDecimalDigits("١٢٣")).toBe(true)
	expect(isDecimalDigits("²")).toBe(false)
	expect(isDecimalDigits("①")).toBe(false)
	expect(isDecimalDigits("")).toBe(false)
	expect(isDecimalDigits("12a")).toBe(false)
})

test("letters include CJK ideographs of every extension, marks do not", () => {
	expect(isLetter("é")).toBe(true)
	expect(isLetter("𦑃")).toBe(true)
	expect(isLetter("\u{323B0}")).toBe(true)
	expect(isLetter("ी")).toBe(false)
	expect(isLetter("1")).toBe(false)
})

test("whitespace splits and line splits", () => {
	expect(isWhitespaceCharacter("　")).toBe(true)
	expect(isWhitespaceCharacter("x")).toBe(false)
	expect(splitWhitespace("  a\tb　c  ")).toEqual(["a", "b", "c"])
	expect(splitWhitespace(" \n ")).toEqual([])
	expect(splitLines("a\r\nb\nc\rd\n")).toEqual(["a", "b", "c", "d"])
	expect(splitLines("")).toEqual([])
})

test("capitalize upper-cases the first character and lower-cases the rest", () => {
	expect(capitalize("RUE")).toBe("Rue")
	expect(capitalize("éCOLE")).toBe("École")
	expect(capitalize("")).toBe("")
})
