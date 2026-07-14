/**
 * Cross-language parity for the country-lexicon matcher (#1104). These assertions MIRROR corpus-python's
 * test_country_lexicon.py — if the TS matcher drifts from the Python one, the model sees different clues at inference
 * than it trained on. The inline lexicon matches the Python fixture exactly.
 *
 * The critical properties: the LONG leading form ("united states of america") paints every word as an UNAMBIGUOUS
 * country surface (the whole point — this is the WOF-admin case the tagger reads as a street); homographs ("georgia",
 * "CA") fire `country_surface` AND `country_ambiguous` symmetrically (the model disambiguates via context); short codes
 * match uppercase-only ("us" the word ≠ "US"); and the char→piece projection mirrors the anchor's first-non-ws rule.
 */

import { describe, expect, it } from "vitest"

import {
	buildCountryFeatures,
	COUNTRY_AMBIGUOUS_BIT,
	COUNTRY_SURFACE_BIT,
	parseCountryLexicon,
} from "./country-inference.ts"
import { gazetteerCharPaint } from "./gazetteer-inference.ts"
import type { TokenizedPiece } from "./tokenizer.ts"

const S = COUNTRY_SURFACE_BIT // 1
const A = COUNTRY_AMBIGUOUS_BIT // 2

const LEXICON = parseCountryLexicon({
	feature_dim: 2,
	slots: ["country_surface", "country_ambiguous"],
	bits: { country_surface: 1, country_ambiguous: 2 },
	max_ngram: 4,
	entries: {
		"united states of america": S,
		"united states": S,
		america: S | A, // common-word surface → ambiguous
		france: S,
		georgia: S | A, // homograph with a US region → ambiguous
		"costa rica": S,
	},
	code_entries: {
		USA: S,
		US: S,
		CA: S | A, // Canada code / California abbreviation → ambiguous
		FR: S,
	},
})

/** Bits painted on the first kept char of each whitespace word (shared paint with the gazetteer). */
function paintedWords(raw: string): Record<string, number> {
	const charBits = gazetteerCharPaint(raw, LEXICON)
	const out: Record<string, number> = {}

	for (const m of raw.matchAll(/\S+/g)) {
		const word = m[0].replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "")

		for (let c = m.index; c < m.index + m[0].length; c++) {
			if (/[A-Za-z0-9]/.test(raw[c]!)) {
				out[word] = charBits[c]!
				break
			}
		}
	}

	return out
}

describe("country matcher parity", () => {
	it("the long leading form paints every word as an unambiguous country surface", () => {
		// The #1104 WOF-admin case: the 4-token phrase the learned tagger reads as a leading street.
		const w = paintedWords("United States of America, Wyoming, Cheyenne")
		expect(w["United"]).toBe(S)
		expect(w["States"]).toBe(S)
		expect(w["of"]).toBe(S)
		expect(w["America"]).toBe(S) // inside the phrase → NOT the standalone ambiguous "america"
		expect(w["Wyoming"]).toBe(0) // a US region, not a country surface
		expect(w["Cheyenne"]).toBe(0)
	})

	it("standalone 'America' is an ambiguous surface (fires, but flagged)", () => {
		expect(paintedWords("123 America Avenue")["America"]).toBe(S | A)
	})

	it("homograph clue is symmetric and flagged ambiguous (both contexts identical)", () => {
		const expected = S | A
		expect(paintedWords("291 Hill Road, Atlanta, Georgia 30601")["Georgia"]).toBe(expected)
		expect(paintedWords("772 Main Street, Tbilisi, Georgia")["Georgia"]).toBe(expected)
		expect(paintedWords("291 Hill Road, Atlanta, Georgia 30601")["Atlanta"]).toBe(0)
	})

	it("short codes match uppercase only ('us' the word ≠ 'US')", () => {
		expect(paintedWords("New York, NY 10001, USA")["USA"]).toBe(S)
		expect(paintedWords("meet us there")["us"]).toBe(0)
		expect(paintedWords("Toronto, ON, CA")["CA"]).toBe(S | A) // Canada / California homograph
		expect(paintedWords("Paris, FR")["FR"]).toBe(S)
	})

	it("multi-word country paints every word, longest-first; unambiguous names too", () => {
		const w = paintedWords("San Jose, Costa Rica")
		expect(w["Costa"]).toBe(S)
		expect(w["Rica"]).toBe(S)
		expect(paintedWords("Paris, France")["France"]).toBe(S)
	})

	it("strips punctuation around the surface", () => {
		expect(paintedWords("Cheyenne, United States.")["United"]).toBe(S)
		expect(paintedWords("Cheyenne, United States.")["States"]).toBe(S)
	})

	it("projects onto pieces by first-non-ws char, emits [surface, ambiguous], pads zero", () => {
		const raw = "Tbilisi, Georgia"
		const pieces: TokenizedPiece[] = [
			{ piece: "Tbilisi", id: 10, start: 0, end: 7 },
			{ piece: ", ", id: 11, start: 7, end: 9 },
			{ piece: "Geo", id: 12, start: 9, end: 12 },
			{ piece: "rgia", id: 13, start: 12, end: 16 },
		]
		const { features, confidence } = buildCountryFeatures(raw, pieces, LEXICON)
		expect(features[0]).toEqual([0, 0]) // Tbilisi: no clue
		expect(confidence[0]).toBe(0)
		expect(features[1]).toEqual([0, 0]) // ", " → first non-ws is "," (stripped)
		expect(features[2]).toEqual([1, 1]) // Georgia: surface + ambiguous
		expect(features[3]).toEqual([1, 1])
		expect(confidence[2]).toBe(1)
	})

	it("unambiguous long form projects [1, 0] with confidence 1", () => {
		const raw = "United States of America"
		const pieces: TokenizedPiece[] = [
			{ piece: "United", id: 1, start: 0, end: 6 },
			{ piece: " States", id: 2, start: 6, end: 13 },
			{ piece: " of", id: 3, start: 13, end: 16 },
			{ piece: " America", id: 4, start: 16, end: 24 },
		]
		const { features, confidence } = buildCountryFeatures(raw, pieces, LEXICON)

		for (let i = 0; i < 4; i++) {
			expect(features[i]).toEqual([1, 0])
			expect(confidence[i]).toBe(1)
		}
	})
})
