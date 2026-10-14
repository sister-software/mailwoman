/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Unit tests for the street-morphology emission bias function. Asserts the two-pass behavior:
 *   matched affix tokens get positive bias on street_prefix/street_suffix. adjacent name tokens get
 *   positive bias on street and negative bias on dependent_locality.
 */

import type { AncestrieMatch } from "@mailwoman/ancestrie"
import { describe, expect, it } from "vitest"

import type { FSTMatcherLike, FSTPlaceEntryLike } from "#fst-prior"
import { STAGE3_BIO_LABELS } from "#labels"
import { buildStreetMorphologyEmissionPriors } from "#street-morphology-prior"

function labelCol(label: string): number {
	return STAGE3_BIO_LABELS.indexOf(label as (typeof STAGE3_BIO_LABELS)[number])
}

function mockAffixFST(affixSurfaces: string[]): FSTMatcherLike {
	const states = new Map<string, { id: number; entries: FSTPlaceEntryLike[] }>()
	let nextID = 1

	for (const surface of affixSurfaces) {
		states.set(surface, {
			id: nextID++,
			entries: [{ wofID: 1_900_000_000 + nextID, placetype: "street_affix", referential: 1 }],
		})
	}

	return {
		walk(tokens: string[]): AncestrieMatch | null {
			const key = tokens.join(" ")
			const state = states.get(key)

			if (state) return { stateID: state.id, accepted: true, depth: tokens.length }

			return null
		},
		walkFrom(): AncestrieMatch | null {
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

describe("buildStreetMorphologyEmissionPriors", () => {
	it("produces a zero matrix when no morphology FST matches", () => {
		const fst = mockAffixFST([])
		const pieces = makePieces("hello world")
		const matrix = buildStreetMorphologyEmissionPriors(fst, pieces, STAGE3_BIO_LABELS)

		for (const row of matrix) {
			expect(row.every((v) => v === 0)).toBe(true)
		}
	})

	it("biases matched affix tokens toward both street_prefix and street_suffix", () => {
		const fst = mockAffixFST(["avenue"])
		const pieces = makePieces("5th avenue") // tokens: "5th", "avenue"
		const matrix = buildStreetMorphologyEmissionPriors(fst, pieces, STAGE3_BIO_LABELS)

		const avenueRow = matrix[1]! // pieces[1] = "▁avenue"
		expect(avenueRow[labelCol("B-street_prefix")]!).toBeGreaterThan(0)
		expect(avenueRow[labelCol("B-street_suffix")]!).toBeGreaterThan(0)
	})

	it("biases the adjacent name token toward street and away from dependent_locality", () => {
		const fst = mockAffixFST(["avenue"])
		const pieces = makePieces("5th avenue") // matched: pieces[1], adjacent-before: pieces[0]
		const matrix = buildStreetMorphologyEmissionPriors(fst, pieces, STAGE3_BIO_LABELS)

		const fifthRow = matrix[0]! // pieces[0] = "▁5th"
		expect(fifthRow[labelCol("B-street")]!).toBeGreaterThan(0)
		expect(fifthRow[labelCol("B-dependent_locality")]!).toBeLessThan(0)
	})

	it("biases neighbors on BOTH sides of an affix span", () => {
		const fst = mockAffixFST(["rue"])
		const pieces = makePieces("123 rue cassette") // matched: pieces[1], adjacent before+after
		const matrix = buildStreetMorphologyEmissionPriors(fst, pieces, STAGE3_BIO_LABELS)

		// "123" (before the affix) → street bias, anti-dep_locality
		const beforeRow = matrix[0]!
		expect(beforeRow[labelCol("B-street")]!).toBeGreaterThan(0)
		expect(beforeRow[labelCol("B-dependent_locality")]!).toBeLessThan(0)

		// "cassette" (after the affix) → street bias, anti-dep_locality
		const afterRow = matrix[2]!
		expect(afterRow[labelCol("B-street")]!).toBeGreaterThan(0)
		expect(afterRow[labelCol("B-dependent_locality")]!).toBeLessThan(0)

		// "rue" (the affix itself) → prefix + suffix bias, but not dependent_locality penalty
		const affixRow = matrix[1]!
		expect(affixRow[labelCol("B-street_prefix")]!).toBeGreaterThan(0)
		expect(affixRow[labelCol("B-street_suffix")]!).toBeGreaterThan(0)
		expect(affixRow[labelCol("B-dependent_locality")]!).toBe(0)
	})

	it("respects custom bias magnitudes", () => {
		const fst = mockAffixFST(["avenue"])
		const pieces = makePieces("elm avenue")

		const matrix = buildStreetMorphologyEmissionPriors(fst, pieces, STAGE3_BIO_LABELS, {
			maxAffixBias: 5,
			maxNeighbourStreetBias: 4,
			dependentLocalityPenalty: 7,
		})

		expect(matrix[1]![labelCol("B-street_prefix")]!).toBe(5)
		expect(matrix[0]![labelCol("B-street")]!).toBe(4)
		expect(matrix[0]![labelCol("B-dependent_locality")]!).toBe(-7)
	})

	it("gives no neighbor bias across a comma", () => {
		const fst = mockAffixFST(["avenue"])
		const pieces = makePieces("7 HILLVIEW AVENUE, KINGSTON 10") // "AVENUE," holds the comma
		const matrix = buildStreetMorphologyEmissionPriors(fst, pieces, STAGE3_BIO_LABELS)

		expect(matrix[1]![labelCol("B-street")]!).toBeGreaterThan(0)
		expect(matrix[3]![labelCol("B-street")]!).toBe(0)
		expect(matrix[3]![labelCol("B-dependent_locality")]!).toBe(0)
	})

	describe("numberedSegmentOnly", () => {
		const fst = mockAffixFST(["plaza"])

		it("biases an affix whose segment opens with a house number", () => {
			// "Plaza," is one piece holding the comma.
			const pieces = makePieces("30 Rockefeller Plaza, New York")

			const matrix = buildStreetMorphologyEmissionPriors(fst, pieces, STAGE3_BIO_LABELS, {
				numberedSegmentOnly: true,
			})

			expect(matrix[2]![labelCol("B-street_suffix")]!).toBeGreaterThan(0)
			expect(matrix[1]![labelCol("B-street")]!).toBeGreaterThan(0)
		})

		it("leaves an affix alone when nothing numbered opens its segment", () => {
			const pieces = makePieces("Rockefeller Plaza, New York")

			const matrix = buildStreetMorphologyEmissionPriors(fst, pieces, STAGE3_BIO_LABELS, {
				numberedSegmentOnly: true,
			})

			for (const row of matrix) {
				expect(row.every((v) => v === 0)).toBe(true)
			}
		})

		it("reads the number from the affix's own segment, not an earlier one", () => {
			const pieces = makePieces("Suite 4, Rockefeller Plaza, New York")

			const matrix = buildStreetMorphologyEmissionPriors(fst, pieces, STAGE3_BIO_LABELS, {
				numberedSegmentOnly: true,
			})

			for (const row of matrix) {
				expect(row.every((v) => v === 0)).toBe(true)
			}
		})

		it("gives no prefix bias and no bias to the word after the affix", () => {
			const pieces = makePieces("30 Rockefeller Plaza, New York")

			const matrix = buildStreetMorphologyEmissionPriors(fst, pieces, STAGE3_BIO_LABELS, {
				numberedSegmentOnly: true,
			})

			expect(matrix[2]![labelCol("B-street_prefix")]!).toBe(0)
			expect(matrix[3]![labelCol("B-street")]!).toBe(0)
		})

		it("leaves an affix inside the name alone", () => {
			const fstWithRte = mockAffixFST(["rte", "rd"])
			const pieces = makePieces("05350 VT State Rte 100")

			const matrix = buildStreetMorphologyEmissionPriors(fstWithRte, pieces, STAGE3_BIO_LABELS, {
				numberedSegmentOnly: true,
			})

			for (const row of matrix) {
				expect(row.every((v) => v === 0)).toBe(true)
			}

			const trailing = makePieces("05161 Cider Mill Rd VT")

			const trailingMatrix = buildStreetMorphologyEmissionPriors(fstWithRte, trailing, STAGE3_BIO_LABELS, {
				numberedSegmentOnly: true,
			})

			expect(trailingMatrix[3]![labelCol("B-street_suffix")]!).toBe(0)
		})

		it("leaves an affix that opens the name alone", () => {
			const fstWithRue = mockAffixFST(["rue"])
			const pieces = makePieces("12 Rue de Rivoli, Paris")

			const matrix = buildStreetMorphologyEmissionPriors(fstWithRue, pieces, STAGE3_BIO_LABELS, {
				numberedSegmentOnly: true,
			})

			for (const row of matrix) {
				expect(row.every((v) => v === 0)).toBe(true)
			}
		})

		it("is off by default, so an unnumbered affix keeps its bias", () => {
			const pieces = makePieces("Rockefeller Plaza, New York")
			const matrix = buildStreetMorphologyEmissionPriors(fst, pieces, STAGE3_BIO_LABELS)

			expect(matrix[1]![labelCol("B-street_suffix")]!).toBeGreaterThan(0)
		})
	})
})
