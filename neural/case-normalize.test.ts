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

test("titleCaseInput: title-cases ≥3-letter runs, PRESERVES ≤2-letter runs, length-preserving", () => {
	expect(titleCaseInput("PALESTINE")).toBe("Palestine")
	// ≤2-letter runs stay shouting — they're abbreviations the model reads correctly all-caps (suffix RD).
	expect(titleCaseInput("214 JONES RD")).toBe("214 Jones RD")
	const input = "ELKHART TX"
	expect(titleCaseInput(input)).toHaveLength(input.length) // offsets unchanged
})

test("titleCaseInput: #252 — a 2-letter region/directional is preserved, not corrupted to a non-region form", () => {
	// The Gauntlet casing-invariance catch: blind title-casing made NY→Ny / DC→Dc / NW→Nw, which the model
	// then parsed as a LOCALITY, dropping the state. Preserving them lands UPPER on the correct mixed-case form.
	expect(titleCaseInput("WASHINGTON DC")).toBe("Washington DC")
	expect(titleCaseInput("NEW YORK NY")).toBe("New York NY")
	expect(titleCaseInput("1600 PENNSYLVANIA AVE NW")).toBe("1600 Pennsylvania Ave NW")
})

test("normalizeInputCase: the #690 hook — title-case iff all-caps, else unchanged", () => {
	// ELKHART→Elkhart (the #690 locality recovery) AND RD/TX preserved (the #252 region/suffix fix).
	expect(normalizeInputCase("214 JONES RD, ELKHART, TX 75839")).toBe("214 Jones RD, Elkhart, TX 75839")
	// mixed-case and non-ASCII inputs pass through byte-for-byte
	expect(normalizeInputCase("214 Jones Rd")).toBe("214 Jones Rd")
	expect(normalizeInputCase("MÜNCHEN HBF")).toBe("MÜNCHEN HBF")
})
