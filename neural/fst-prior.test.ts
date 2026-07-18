/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { buildFSTEmissionPriors, type FSTMatcherLike, type FSTMatchLike, type FSTPlaceEntryLike } from "./fst-prior.ts"
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
