/**
 * Cross-language parity for the gazetteer-anchor matcher (#464). These assertions MIRROR corpus-python's
 * test_gazetteer_anchor.py — if the TS matcher drifts from the Python one, the model sees different clues at inference
 * than it trained on. The inline lexicon matches the Python fixture exactly.
 */

import { describe, expect, it } from "vitest"

import { buildGazetteerFeatures, gazetteerCharPaint, parseGazetteerLexicon } from "./gazetteer-inference.js"
import type { TokenizedPiece } from "./tokenizer.js"

const BITS = { country: 1, region: 2, po_box: 4, cedex: 8, homograph: 16 }
const LEXICON = parseGazetteerLexicon({
	feature_dim: 5,
	slots: ["country", "region", "po_box", "cedex", "homograph"],
	bits: BITS,
	max_ngram: 3,
	entries: {
		georgia: BITS.country | BITS.region | BITS.homograph,
		jordan: BITS.country | BITS.region | BITS.homograph,
		france: BITS.country,
		"costa rica": BITS.country,
		"timor-leste": BITS.country,
		"united states": BITS.country,
		"po box": BITS.po_box,
		box: BITS.po_box,
		cedex: BITS.cedex,
	},
	code_entries: {
		CA: BITS.country | BITS.region | BITS.homograph,
		IN: BITS.country | BITS.region | BITS.homograph,
		TX: BITS.region,
		FR: BITS.country,
	},
})

/** Bits painted on the first kept char of each whitespace word. */
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

describe("gazetteer matcher parity", () => {
	it("homograph clue is symmetric (both contexts identical)", () => {
		const expected = BITS.country | BITS.region | BITS.homograph
		expect(paintedWords("291 Hill Road, Atlanta, Georgia 30601")["Georgia"]).toBe(expected)
		expect(paintedWords("772 Main Street, Tbilisi, Georgia")["Georgia"]).toBe(expected)
		expect(paintedWords("291 Hill Road, Atlanta, Georgia 30601")["Atlanta"]).toBe(0)
	})

	it("short codes match uppercase only ('in' ≠ 'IN')", () => {
		const homo = BITS.country | BITS.region | BITS.homograph
		expect(paintedWords("Los Angeles, CA 90012")["CA"]).toBe(homo)
		expect(paintedWords("turn left in paris")["in"]).toBe(0)
		expect(paintedWords("the ca registry")["ca"]).toBe(0)
		expect(paintedWords("Indianapolis, IN 46204")["IN"]).toBe(homo)
	})

	it("multi-word country paints every word, longest-first", () => {
		const w = paintedWords("San Jose, Costa Rica")
		expect(w["Costa"]).toBe(BITS.country)
		expect(w["Rica"]).toBe(BITS.country)
		const u = paintedWords("New York, NY 10001, United States")
		expect(u["United"]).toBe(BITS.country)
		expect(u["States"]).toBe(BITS.country)
	})

	it("strips punctuation; hyphenated entry matches", () => {
		expect(paintedWords("Tbilisi, Georgia, hello")["Georgia"]).toBe(BITS.country | BITS.region | BITS.homograph)
		expect(paintedWords("Dili, Timor-Leste")["Timor-Leste"]).toBe(BITS.country)
	})

	it("po_box / cedex clues fire (a hint, not a verdict — 'Box Canyon' too)", () => {
		const w = paintedWords("PO Box 1234, Springfield")
		expect(w["PO"]).toBe(BITS.po_box)
		expect(w["Box"]).toBe(BITS.po_box)
		expect(paintedWords("12 Box Canyon Rd")["Box"]).toBe(BITS.po_box)
		expect(paintedWords("75008 PARIS CEDEX 02")["CEDEX"]).toBe(BITS.cedex)
	})

	it("projects onto pieces by first-non-ws char, pads zero", () => {
		const raw = "Tbilisi, Georgia"
		const pieces: TokenizedPiece[] = [
			{ piece: "Tbilisi", id: 10, start: 0, end: 7 },
			{ piece: ", ", id: 11, start: 7, end: 9 },
			{ piece: "Geo", id: 12, start: 9, end: 12 },
			{ piece: "rgia", id: 13, start: 12, end: 16 },
		]
		const { features, confidence } = buildGazetteerFeatures(raw, pieces, LEXICON)
		expect(features[0]).toEqual([0, 0, 0, 0, 0])
		expect(confidence[0]).toBe(0)
		expect(features[1]).toEqual([0, 0, 0, 0, 0]) // ", " → first non-ws is "," (stripped)
		expect(features[2]).toEqual([1, 1, 0, 0, 1]) // Georgia homograph
		expect(features[3]).toEqual([1, 1, 0, 0, 1])
		expect(confidence[2]).toBe(1)
	})
})
