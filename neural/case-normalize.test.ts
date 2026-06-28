/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { expect, test } from "vitest"

import { isAllCapsInput, normalizeInputCase, titleCaseInput } from "./case-normalize.js"

test("isAllCapsInput: a pure-ASCII shouting address qualifies", () => {
	expect(isAllCapsInput("214 JONES RD, ELKHART, TX 75839")).toBe(true)
	expect(isAllCapsInput("ABC")).toBe(true)
})

test("isAllCapsInput: any lowercase letter disqualifies (mixed case stays byte-stable)", () => {
	expect(isAllCapsInput("214 Jones Rd")).toBe(false)
	expect(isAllCapsInput("MAINe ST")).toBe(false)
})

test("isAllCapsInput: any non-ASCII char disqualifies (the length-invariant guard)", () => {
	// title-casing ß→SS / Turkish I is length-changing & locale-sensitive → left untouched.
	expect(isAllCapsInput("STRASSE PARÍS")).toBe(false)
	expect(isAllCapsInput("MÜNCHEN")).toBe(false)
})

test("isAllCapsInput: needs ≥3 cased letters; digits/punctuation alone do not qualify", () => {
	expect(isAllCapsInput("TX")).toBe(false) // only 2 uppercase
	expect(isAllCapsInput("123 456")).toBe(false) // no cased letters
	expect(isAllCapsInput("")).toBe(false)
})

test("titleCaseInput: title-cases each ASCII alpha run, length-preserving", () => {
	expect(titleCaseInput("PALESTINE")).toBe("Palestine")
	expect(titleCaseInput("214 JONES RD")).toBe("214 Jones Rd")
	const input = "ELKHART TX"
	expect(titleCaseInput(input)).toHaveLength(input.length) // offsets unchanged
})

test("normalizeInputCase: the #690 hook — title-case iff all-caps, else unchanged", () => {
	expect(normalizeInputCase("214 JONES RD, ELKHART, TX 75839")).toBe("214 Jones Rd, Elkhart, Tx 75839")
	// mixed-case and non-ASCII inputs pass through byte-for-byte
	expect(normalizeInputCase("214 Jones Rd")).toBe("214 Jones Rd")
	expect(normalizeInputCase("MÜNCHEN HBF")).toBe("MÜNCHEN HBF")
})
