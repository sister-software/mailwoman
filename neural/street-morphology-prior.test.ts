/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Unit tests for the street-morphology emission bias function. Asserts the two-pass behaviour:
 *   matched affix tokens get positive bias on street_prefix/street_suffix; adjacent name tokens get
 *   positive bias on street AND negative bias on dependent_locality.
 */

import { describe, expect, it } from "vitest"

import { type FSTMatcherLike, type FSTMatchLike, type FSTPlaceEntryLike } from "./fst-prior.js"
import { STAGE3_BIO_LABELS } from "./labels.js"
import { buildStreetMorphologyEmissionPriors } from "./street-morphology-prior.js"

function labelCol(label: string): number {
	return STAGE3_BIO_LABELS.indexOf(label as (typeof STAGE3_BIO_LABELS)[number])
}

function mockAffixFST(affixSurfaces: string[]): FSTMatcherLike {
	const states = new Map<string, { id: number; entries: FSTPlaceEntryLike[] }>()
	let nextId = 1

	for (const surface of affixSurfaces) {
		states.set(surface, {
			id: nextId++,
			entries: [{ wofID: 1_900_000_000 + nextId, placetype: "street_affix", importance: 1.0 }],
		})
	}

	return {
		walk(tokens: string[]): FSTMatchLike | null {
			const key = tokens.join(" ")
			const state = states.get(key)

			if (state) return { stateId: state.id, accepted: true, depth: tokens.length }

			return null
		},
		walkFrom(): FSTMatchLike | null {
			return null
		},
		accepting(stateId: number): FSTPlaceEntryLike[] {
			for (const [, state] of states) {
				if (state.id === stateId) return state.entries
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

	it("biases neighbours on BOTH sides of an affix span", () => {
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

		// "rue" (the affix itself) → prefix + suffix bias, but NOT dependent_locality penalty
		const affixRow = matrix[1]!
		expect(affixRow[labelCol("B-street_prefix")]!).toBeGreaterThan(0)
		expect(affixRow[labelCol("B-street_suffix")]!).toBeGreaterThan(0)
		expect(affixRow[labelCol("B-dependent_locality")]!).toBe(0)
	})

	it("respects custom bias magnitudes", () => {
		const fst = mockAffixFST(["avenue"])
		const pieces = makePieces("elm avenue")
		const matrix = buildStreetMorphologyEmissionPriors(fst, pieces, STAGE3_BIO_LABELS, {
			maxAffixBias: 5.0,
			maxNeighbourStreetBias: 4.0,
			dependentLocalityPenalty: 7.0,
		})

		expect(matrix[1]![labelCol("B-street_prefix")]!).toBe(5.0)
		expect(matrix[0]![labelCol("B-street")]!).toBe(4.0)
		expect(matrix[0]![labelCol("B-dependent_locality")]!).toBe(-7.0)
	})
})
