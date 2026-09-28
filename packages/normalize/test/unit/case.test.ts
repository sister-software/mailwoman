/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import {
	isAllCapsInput,
	isAllLowerInput,
	normalizeInputCase,
	restoreLowerInput,
	titleCaseInput,
} from "@mailwoman/normalize/case"
import { expect, test } from "vitest"

test("isAllCapsInput: a pure-ASCII shouting address qualifies", () => {
	expect(isAllCapsInput("214 JONES RD, ELKHART, TX 75839")).toBe(true)
	expect(isAllCapsInput("ABC")).toBe(true)
})

test("isAllCapsInput: any lowercase letter disqualifies (mixed case stays byte-stable)", () => {
	expect(isAllCapsInput("214 Jones Rd")).toBe(false)
	expect(isAllCapsInput("MAINe ST")).toBe(false)
})

test("isAllCapsInput: Latin letters with diacritics qualify; a letter from another script disqualifies", () => {
	expect(isAllCapsInput("RUE DU FAUBOURG SAINT-HONORÉ")).toBe(true)
	expect(isAllCapsInput("STRASSE PARÍS")).toBe(true)
	expect(isAllCapsInput("MÜNCHEN")).toBe(true)
	expect(isAllCapsInput("ΑΘΗΝΑ ODOS")).toBe(false)
	expect(isAllCapsInput("МОСКВА STREET")).toBe(false)
	expect(isAllCapsInput("RUE D’ULM")).toBe(true)
})

test("isAllCapsInput: needs ≥3 cased letters; digits/punctuation alone do not qualify", () => {
	expect(isAllCapsInput("TX")).toBe(false)
	expect(isAllCapsInput("123 456")).toBe(false)
	expect(isAllCapsInput("")).toBe(false)
})

test("titleCaseInput: title-cases ≥3-letter runs, PRESERVES ≤2-letter runs, length-preserving", () => {
	expect(titleCaseInput("PALESTINE")).toBe("Palestine")
	expect(titleCaseInput("214 JONES RD")).toBe("214 Jones RD")
	const input = "ELKHART TX"
	expect(titleCaseInput(input)).toHaveLength(input.length)
})

test("titleCaseInput: #252 — a 2-letter region/directional is preserved, not corrupted to a non-region form", () => {
	expect(titleCaseInput("WASHINGTON DC")).toBe("Washington DC")
	expect(titleCaseInput("NEW YORK NY")).toBe("New York NY")
	expect(titleCaseInput("1600 PENNSYLVANIA AVE NW")).toBe("1600 Pennsylvania Ave NW")
})

test("normalizeInputCase: the #690 hook — title-case iff all-caps, else unchanged", () => {
	expect(normalizeInputCase("214 JONES RD, ELKHART, TX 75839")).toBe("214 Jones RD, Elkhart, TX 75839")
	expect(normalizeInputCase("214 Jones Rd")).toBe("214 Jones Rd")
	expect(normalizeInputCase("MÜNCHEN HBF")).toBe("München Hbf")
	expect(normalizeInputCase("RUE DU FAUBOURG SAINT-HONORÉ")).toBe("Rue DU Faubourg Saint-Honoré")
	expect(normalizeInputCase("AVENUE DES CHAMPS-ÉLYSÉES")).toBe("Avenue Des Champs-Élysées")
})

test("titleCaseInput: a run whose lowercase form changes length is kept as typed (offsets never move)", () => {
	// U+0130 lowercases to two code units.
	// In `caddesİ` it sits inside the lowered tail, so that run stays shouting rather than shifting
	// every later offset, while in `İstanbul` it is the untouched first letter and the run title-cases.
	const input = "İSTANBUL CADDESİ"
	const out = titleCaseInput(input)

	expect(out).toHaveLength(input.length)
	expect(out).toBe("İstanbul CADDESİ")
})

test("isAllLowerInput: #829 — pure-ASCII whispering qualifies; one uppercase or non-ASCII disqualifies", () => {
	expect(isAllLowerInput("1600 pennsylvania ave nw, washington dc")).toBe(true)
	expect(isAllLowerInput("214 Jones rd")).toBe(false)
	expect(isAllLowerInput("straße parís")).toBe(false)
	expect(isAllLowerInput("tx")).toBe(false)
})

test("restoreLowerInput: #829 — title-case ≥3-letter runs, UPPERCASE ≤2-letter runs, length-preserving", () => {
	// The two-letter rule differs from `titleCaseInput`, since a lowercase two-letter
	// token is an abbreviation the model reads as shouting.
	expect(restoreLowerInput("washington dc")).toBe("Washington DC")
	expect(restoreLowerInput("new york ny")).toBe("New York NY")
	expect(restoreLowerInput("1012 lg amsterdam")).toBe("1012 LG Amsterdam")
	const input = "1600 pennsylvania ave nw"
	expect(restoreLowerInput(input)).toHaveLength(input.length)
})

test("normalizeInputCase: #829 — all-lowercase canonicalizes to the trained mixed-case; converges with all-caps", () => {
	const canon = "1600 Pennsylvania Ave NW, Washington DC"
	expect(normalizeInputCase("1600 pennsylvania ave nw, washington dc")).toBe(canon)
	expect(normalizeInputCase("1600 PENNSYLVANIA AVE NW, WASHINGTON DC")).toBe(canon)
	expect(normalizeInputCase("café de parís")).toBe("café de parís")
})
