/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import {
	buildFSTEmissionPriors,
	groupPiecesIntoWords,
	normalizeFSTToken,
	type FSTMatcherLike,
	type FSTMatchLike,
	type FSTPlaceEntryLike,
} from "./fst-prior.ts"
import { STAGE2_BIO_LABELS } from "./labels.ts"

function labelCol(label: string): number {
	return STAGE2_BIO_LABELS.indexOf(label as (typeof STAGE2_BIO_LABELS)[number])
}

function mockFST(entries: Map<string, FSTPlaceEntryLike[]>): FSTMatcherLike {
	const states = new Map<string, { id: number; entries: FSTPlaceEntryLike[] }>()
	let nextID = 1

	for (const [path, places] of entries) {
		states.set(path, { id: nextID++, entries: places })
	}

	return {
		walk(tokens: string[]): FSTMatchLike | null {
			const key = tokens.join(" ")
			const state = states.get(key)

			if (state) return { stateID: state.id, accepted: state.entries.length > 0, depth: tokens.length }

			for (const [path] of states) {
				if (path.startsWith(key + " ") || path === key) {
					return { stateID: 0, accepted: false, depth: tokens.length }
				}
			}

			return null
		},
		walkFrom(prev: FSTMatchLike, token: string): FSTMatchLike | null {
			for (const [path, state] of states) {
				const parts = path.split(" ")

				if (parts.length > prev.depth && parts[prev.depth] === token) {
					const subpath = parts.slice(0, prev.depth + 1).join(" ")
					const exactState = states.get(subpath)

					if (exactState) {
						return { stateID: exactState.id, accepted: exactState.entries.length > 0, depth: prev.depth + 1 }
					}

					return { stateID: 0, accepted: false, depth: prev.depth + 1 }
				}
			}

			return null
		},
		accepting(stateID: number): FSTPlaceEntryLike[] {
			for (const [, state] of states) {
				if (state.id === stateID) return state.entries
			}

			return []
		},
	}
}

function makePieces(text: string): Array<{ piece: string; start: number; end: number }> {
	const words = text.split(/\s+/)
	const pieces: Array<{ piece: string; start: number; end: number }> = []
	let cursor = 0

	for (const word of words) {
		const start = text.indexOf(word, cursor)
		pieces.push({ piece: `▁${word}`, start, end: start + word.length })
		cursor = start + word.length
	}

	return pieces
}

describe("buildFSTEmissionPriors", () => {
	it("produces zero matrix when no FST matches", () => {
		const fst = mockFST(new Map())
		const pieces = makePieces("hello world")
		const matrix = buildFSTEmissionPriors(fst, pieces, STAGE2_BIO_LABELS)

		for (const row of matrix) {
			expect(row.every((v) => v === 0)).toBe(true)
		}
	})

	it("biases matched locality tokens proportional to importance", () => {
		const fst = mockFST(new Map([["portland", [{ wofID: 1, placetype: "locality", importance: 0.72 }]]]))
		const pieces = makePieces("Portland")
		const matrix = buildFSTEmissionPriors(fst, pieces, STAGE2_BIO_LABELS)
		expect(matrix[0]![labelCol("B-locality")]).toBeCloseTo(0.72 * 3.0, 2)
		expect(matrix[0]![labelCol("B-street")]).toBeLessThan(0)
	})

	it("biases multi-word place names with B/I convention", () => {
		const fst = mockFST(
			new Map([
				["new", []],
				[
					"new york",
					[
						{ wofID: 2, placetype: "locality", importance: 0.95 },
						{ wofID: 3, placetype: "region", importance: 0.85 },
					],
				],
			])
		)
		const pieces = makePieces("New York")
		const matrix = buildFSTEmissionPriors(fst, pieces, STAGE2_BIO_LABELS)

		expect(matrix[0]![labelCol("B-locality")]).toBeCloseTo(0.95 * 3.0, 2)
		expect(matrix[1]![labelCol("I-locality")]).toBeCloseTo(0.95 * 3.0, 2)
		expect(matrix[0]![labelCol("B-region")]).toBeCloseTo(0.85 * 3.0, 2)
		expect(matrix[0]![labelCol("B-locality")]).toBeGreaterThan(matrix[0]![labelCol("B-region")]!)
	})

	it("low importance produces proportionally lower bias", () => {
		const fst = mockFST(new Map([["hamlet", [{ wofID: 4, placetype: "locality", importance: 0.05 }]]]))
		const pieces = makePieces("Hamlet")
		const matrix = buildFSTEmissionPriors(fst, pieces, STAGE2_BIO_LABELS)
		expect(matrix[0]![labelCol("B-locality")]).toBeCloseTo(0.15, 2)
	})

	it("does not bias unmapped placetypes (county)", () => {
		const fst = mockFST(new Map([["cook", [{ wofID: 5, placetype: "county", importance: 0.88 }]]]))
		const pieces = makePieces("Cook")
		const matrix = buildFSTEmissionPriors(fst, pieces, STAGE2_BIO_LABELS)

		for (const row of matrix) {
			expect(row.every((v) => v === 0)).toBe(true)
		}
	})

	it("handles subword pieces correctly", () => {
		const fst = mockFST(new Map([["springfield", [{ wofID: 6, placetype: "locality", importance: 0.45 }]]]))
		const pieces = [
			{ piece: "▁Spring", start: 0, end: 6 },
			{ piece: "field", start: 6, end: 11 },
		]
		const matrix = buildFSTEmissionPriors(fst, pieces, STAGE2_BIO_LABELS)
		expect(matrix[0]![labelCol("B-locality")]).toBeCloseTo(0.45 * 3.0, 2)
		expect(matrix[1]![labelCol("I-locality")]).toBeCloseTo(0.45 * 3.0, 2)
	})

	it("skips punctuation-only tokens", () => {
		const fst = mockFST(new Map([["washington", [{ wofID: 7, placetype: "locality", importance: 0.85 }]]]))
		const pieces = [
			{ piece: "▁Washington", start: 0, end: 10 },
			{ piece: ",", start: 10, end: 11 },
			{ piece: "▁DC", start: 12, end: 14 },
		]
		const matrix = buildFSTEmissionPriors(fst, pieces, STAGE2_BIO_LABELS)
		expect(matrix[0]![labelCol("B-locality")]).toBeCloseTo(0.85 * 3.0, 2)
		expect(matrix[1]!.every((v) => v === 0)).toBe(true)
	})

	it("length-scales street suppression for a single-token match (default `suppression` mode), positive bias intact (#1142)", () => {
		// A lone place-name token ("Sweeney") is weak street-head evidence. The default `suppression` mode
		// scales the street/house-number suppression by match length (1-token ×0.25) so the model's own
		// "Ranch Road → street" reading can win, while the POSITIVE locality bias is left at full strength.
		const fst = mockFST(new Map([["sweeney", [{ wofID: 9, placetype: "locality", importance: 0.5 }]]]))
		const pieces = makePieces("Sweeney")
		const supp = buildFSTEmissionPriors(fst, pieces, STAGE2_BIO_LABELS) // default: suppression
		// positive locality bias unscaled (importance * maxBias)
		expect(supp[0]![labelCol("B-locality")]).toBeCloseTo(0.5 * 3.0, 2)
		// street suppression scaled to 0.25 of the -1.5 default
		expect(supp[0]![labelCol("B-street")]).toBeCloseTo(-1.5 * 0.25, 2)

		// `off` gives the full flat suppression (-1.5); `both` also scales the positive bias.
		const off = buildFSTEmissionPriors(fst, pieces, STAGE2_BIO_LABELS, { importanceLengthScaleMode: "off" })
		expect(off[0]![labelCol("B-street")]).toBeCloseTo(-1.5, 2)
		expect(off[0]![labelCol("B-locality")]).toBeCloseTo(0.5 * 3.0, 2)
		const both = buildFSTEmissionPriors(fst, pieces, STAGE2_BIO_LABELS, { importanceLengthScaleMode: "both" })
		expect(both[0]![labelCol("B-locality")]).toBeCloseTo(0.5 * 3.0 * 0.25, 2)
	})
})

describe("normalizeFSTToken", () => {
	it("lowercases and strips hyphens (Stockton-on-Tees → stocktonontees)", () => {
		const result = normalizeFSTToken("Stockton-on-Tees")
		expect(result).toBe("stocktonontees")
	})

	it("leaves spaces intact (Zs, not punctuation) — hyphen/space equivalence comes from the caller's split-then-join", () => {
		// Spaces (U+0020) are Unicode category Zs (separator), not P or S, so normalizeFSTToken leaves them intact.
		// Each word is normalized separately via groupPiecesIntoWords, then words are joined with no separator —
		// that's where "Stockton on Tees" becomes "stocktonontees" (same as "Stockton-on-Tees" after hyphen strip).
		const stockton = normalizeFSTToken("Stockton")
		const on = normalizeFSTToken("on")
		const tees = normalizeFSTToken("Tees")
		expect(stockton + on + tees).toBe("stocktonontees")
	})

	it("preserves diacritics (Álava → álava, not alava)", () => {
		const result = normalizeFSTToken("Álava")
		expect(result).toBe("álava")
	})

	it("strips punctuation including apostrophes (BISHOP'S → bishops)", () => {
		const result = normalizeFSTToken("BISHOP'S")
		expect(result).toBe("bishops")
	})

	it("returns empty string for punctuation-only input", () => {
		const result = normalizeFSTToken("...")
		expect(result).toBe("")
	})

	it("returns empty string for empty input", () => {
		const result = normalizeFSTToken("")
		expect(result).toBe("")
	})

	it("applies NFKC normalization (ligatures and compatibility forms)", () => {
		// NFKC unifies compatibility forms; for example, the NFKC form resolves superscript
		// and subscript characters to their base forms.
		const result = normalizeFSTToken("ﬁnance") // 'ﬁ' is U+FB01 (fi ligature)
		expect(result).toBe("finance")
	})
})

describe("groupPiecesIntoWords with normalizeFSTToken", () => {
	it("normalizes individual word groups correctly", () => {
		const pieces = [{ piece: "▁Stockton" }, { piece: "-" }, { piece: "▁on" }, { piece: "-" }, { piece: "▁Tees" }]
		const groups = groupPiecesIntoWords(pieces)
		// Whitespace-delimited grouping; hyphens are punctuation, so they form separate empty groups
		const nonEmptyGroups = groups.filter((g) => g.fstToken !== "")
		expect(nonEmptyGroups.map((g) => g.fstToken)).toEqual(["stockton", "on", "tees"])
	})

	it("normalizes diacritics consistently in grouped words", () => {
		const pieces = [{ piece: "▁Álava" }]
		const groups = groupPiecesIntoWords(pieces)
		expect(groups[0]!.fstToken).toBe("álava")
	})
})
