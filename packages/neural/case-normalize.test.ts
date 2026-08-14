/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { expect, test } from "vitest"

import {
	isAllCapsInput,
	isAllLowerInput,
	normalizeInputCase,
	restoreLowerInput,
	titleCaseInput,
} from "./case-normalize.ts"

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

test("isAllLowerInput: #829 — pure-ASCII whispering qualifies; one uppercase or non-ASCII disqualifies", () => {
	expect(isAllLowerInput("1600 pennsylvania ave nw, washington dc")).toBe(true)
	expect(isAllLowerInput("214 Jones rd")).toBe(false) // one uppercase → mixed, byte-stable
	expect(isAllLowerInput("straße parís")).toBe(false) // non-ASCII → left untouched
	expect(isAllLowerInput("tx")).toBe(false) // <3 cased letters
})

test("restoreLowerInput: #829 — title-case ≥3-letter runs, UPPERCASE ≤2-letter runs, length-preserving", () => {
	// The ≤2 difference from titleCaseInput: a lowercase 2-letter token is an abbrev the model wants shouting.
	expect(restoreLowerInput("washington dc")).toBe("Washington DC")
	expect(restoreLowerInput("new york ny")).toBe("New York NY")
	expect(restoreLowerInput("1012 lg amsterdam")).toBe("1012 LG Amsterdam")
	const input = "1600 pennsylvania ave nw"
	expect(restoreLowerInput(input)).toHaveLength(input.length) // offsets unchanged
})

test("normalizeInputCase: #829 — all-lowercase canonicalizes to the trained mixed-case; converges with all-caps", () => {
	const canon = "1600 Pennsylvania Ave NW, Washington DC"
	expect(normalizeInputCase("1600 pennsylvania ave nw, washington dc")).toBe(canon)
	expect(normalizeInputCase("1600 PENNSYLVANIA AVE NW, WASHINGTON DC")).toBe(canon) // same target from all-caps
	expect(normalizeInputCase("café de parís")).toBe("café de parís") // lowercase non-ASCII untouched
})
