/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"
import { buildFstEmissionPriors, type FstMatcherLike, type FstMatchLike, type FstPlaceEntryLike } from "./fst-prior.js"
import { STAGE2_BIO_LABELS } from "./labels.js"

function labelCol(label: string): number {
	return STAGE2_BIO_LABELS.indexOf(label as (typeof STAGE2_BIO_LABELS)[number])
}

function mockFst(entries: Map<string, FstPlaceEntryLike[]>): FstMatcherLike {
	const states = new Map<string, { id: number; entries: FstPlaceEntryLike[] }>()
	let nextId = 1

	for (const [path, places] of entries) {
		states.set(path, { id: nextId++, entries: places })
	}

	return {
		walk(tokens: string[]): FstMatchLike | null {
			const key = tokens.join(" ")
			const state = states.get(key)
			if (state) return { stateId: state.id, accepted: state.entries.length > 0, depth: tokens.length }
			for (const [path] of states) {
				if (path.startsWith(key + " ") || path === key) {
					return { stateId: 0, accepted: false, depth: tokens.length }
				}
			}
			return null
		},
		walkFrom(prev: FstMatchLike, token: string): FstMatchLike | null {
			for (const [path, state] of states) {
				const parts = path.split(" ")
				if (parts.length > prev.depth && parts[prev.depth] === token) {
					const subpath = parts.slice(0, prev.depth + 1).join(" ")
					const exactState = states.get(subpath)
					if (exactState) {
						return { stateId: exactState.id, accepted: exactState.entries.length > 0, depth: prev.depth + 1 }
					}
					return { stateId: 0, accepted: false, depth: prev.depth + 1 }
				}
			}
			return null
		},
		accepting(stateId: number): FstPlaceEntryLike[] {
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

describe("buildFstEmissionPriors", () => {
	it("produces zero matrix when no FST matches", () => {
		const fst = mockFst(new Map())
		const pieces = makePieces("hello world")
		const matrix = buildFstEmissionPriors(fst, pieces, STAGE2_BIO_LABELS)
		for (const row of matrix) {
			expect(row.every((v) => v === 0)).toBe(true)
		}
	})

	it("biases matched locality tokens", () => {
		const fst = mockFst(
			new Map([["portland", [{ placetype: "locality", population: 665_000 }]]])
		)
		const pieces = makePieces("Portland")
		const matrix = buildFstEmissionPriors(fst, pieces, STAGE2_BIO_LABELS)
		expect(matrix[0]![labelCol("B-locality")]).toBe(1.0)
	})

	it("biases multi-word place names with B/I convention", () => {
		const fst = mockFst(
			new Map([
				["new", []],
				[
					"new york",
					[
						{ placetype: "locality", population: 8_800_000 },
						{ placetype: "region", population: 20_200_000 },
					],
				],
			])
		)
		const pieces = makePieces("New York")
		const matrix = buildFstEmissionPriors(fst, pieces, STAGE2_BIO_LABELS)

		expect(matrix[0]![labelCol("B-locality")]).toBe(1.0)
		expect(matrix[1]![labelCol("I-locality")]).toBe(1.0)
		expect(matrix[0]![labelCol("B-region")]).toBe(1.0)
		expect(matrix[1]![labelCol("I-region")]).toBe(1.0)
	})

	it("respects biasScale", () => {
		const fst = mockFst(
			new Map([["chicago", [{ placetype: "locality", population: 2_700_000 }]]])
		)
		const pieces = makePieces("Chicago")
		const matrix = buildFstEmissionPriors(fst, pieces, STAGE2_BIO_LABELS, { biasScale: 2.0 })
		expect(matrix[0]![labelCol("B-locality")]).toBe(2.0)
	})

	it("does not bias unmapped placetypes (county)", () => {
		const fst = mockFst(
			new Map([["cook", [{ placetype: "county", population: 5_200_000 }]]])
		)
		const pieces = makePieces("Cook")
		const matrix = buildFstEmissionPriors(fst, pieces, STAGE2_BIO_LABELS)
		for (const row of matrix) {
			expect(row.every((v) => v === 0)).toBe(true)
		}
	})

	it("handles subword pieces correctly", () => {
		const fst = mockFst(
			new Map([["springfield", [{ placetype: "locality", population: 116_000 }]]])
		)
		const pieces = [
			{ piece: "▁Spring", start: 0, end: 6 },
			{ piece: "field", start: 6, end: 11 },
		]
		const matrix = buildFstEmissionPriors(fst, pieces, STAGE2_BIO_LABELS)
		expect(matrix[0]![labelCol("B-locality")]).toBe(1.0)
		expect(matrix[1]![labelCol("I-locality")]).toBe(1.0)
	})

	it("skips punctuation-only tokens", () => {
		const fst = mockFst(
			new Map([["washington", [{ placetype: "locality", population: 678_000 }]]])
		)
		const pieces = [
			{ piece: "▁Washington", start: 0, end: 10 },
			{ piece: ",", start: 10, end: 11 },
			{ piece: "▁DC", start: 12, end: 14 },
		]
		const matrix = buildFstEmissionPriors(fst, pieces, STAGE2_BIO_LABELS)
		expect(matrix[0]![labelCol("B-locality")]).toBe(1.0)
		expect(matrix[1]!.every((v) => v === 0)).toBe(true)
	})
})
