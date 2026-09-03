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
} from "@mailwoman/neural/case-normalize"
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
	// #1938: `É` kept the gate shut and the model read the shouting form letter by letter.
	expect(isAllCapsInput("RUE DU FAUBOURG SAINT-HONORÉ")).toBe(true)
	expect(isAllCapsInput("STRASSE PARÍS")).toBe(true)
	expect(isAllCapsInput("MÜNCHEN")).toBe(true)
	// Non-Latin case rules are locale-sensitive → the whole input is left alone.
	expect(isAllCapsInput("ΑΘΗΝΑ ODOS")).toBe(false)
	expect(isAllCapsInput("МОСКВА STREET")).toBe(false)
	// Uncased non-Latin characters do not disqualify a Latin shouting input.
	expect(isAllCapsInput("RUE D’ULM")).toBe(true)
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
	// Accented Latin shouting title-cases like ASCII (#1938); the ≤2-letter rule is unchanged.
	expect(normalizeInputCase("MÜNCHEN HBF")).toBe("München Hbf")
	expect(normalizeInputCase("RUE DU FAUBOURG SAINT-HONORÉ")).toBe("Rue DU Faubourg Saint-Honoré")
	expect(normalizeInputCase("AVENUE DES CHAMPS-ÉLYSÉES")).toBe("Avenue Des Champs-Élysées")
})

test("titleCaseInput: a run whose lowercase form changes length is kept as typed (offsets never move)", () => {
	// U+0130 lowercases to two code units. In `CADDESİ` it sits inside the lowered tail, so that run stays shouting
	// rather than shifting every later offset; in `İSTANBUL` it is the untouched first letter, so the run title-cases.
	const input = "İSTANBUL CADDESİ"
	const out = titleCaseInput(input)

	expect(out).toHaveLength(input.length)
	expect(out).toBe("İstanbul CADDESİ")
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
