/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Unit tests for the placetype-pair emission bias (placetype-pair-prior arc, Task 4): the
 *   space-joined window-key fold, the two-sided disjoint-window match, marker suppression, and the
 *   `delta ?? biasScale` bias-magnitude resolution. The query-shape-prior.test.ts / street-morphology
 *   mock-index idiom — a hand-built `PairIndexLike` double, no real binary artifact needed.
 */

import { repoRootPath } from "@mailwoman/core/utils"
import { describe, expect, it } from "vitest"

import { STAGE2_BIO_LABELS } from "./labels.ts"
import type { PairIndexLike } from "./pair-index-resolver.ts"
import { buildPlacetypePairPriors } from "./placetype-pair-prior.ts"
import { MailwomanTokenizer } from "./tokenizer.ts"

const LABELS = STAGE2_BIO_LABELS

function labelCol(label: string): number {
	return LABELS.indexOf(label as (typeof LABELS)[number])
}

/**
 * One SentencePiece per word — mirrors `street-morphology-prior.test.ts`'s helper. Sufficient for every test here
 * except the "St Helens" case, which uses the real fixture tokenizer to prove the fold against a genuine multi-piece
 * split.
 */
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

/**
 * A `PairIndexLike` double backed by a plain `(child, parent) -> tag` map, with recorded probe calls so tests can
 * assert on the exact keys probed (the space-join proof needs this).
 */
function mockPairIndex(
	entries: Record<string, string>,
	delta?: number
): PairIndexLike & { calls: Array<[string, string]> } {
	const calls: Array<[string, string]> = []

	return {
		delta,
		calls,
		probe(child: string, parent: string) {
			calls.push([child, parent])

			return entries[`${child}|${parent}`] as never
		},
	}
}

describe("buildPlacetypePairPriors — absence cases", () => {
	it("returns a zero matrix when opts is undefined (no configured index — default OFF)", () => {
		const pieces = makePieces("shoreditch london")
		const matrix = buildPlacetypePairPriors(undefined, pieces, LABELS)

		expect(matrix).toHaveLength(2)

		for (const row of matrix) {
			expect(row.every((v) => v === 0)).toBe(true)
		}
	})

	it("returns a zero matrix when the index is present but never matches (no country data for this locale)", () => {
		const index = mockPairIndex({}) // no entries — every probe misses
		const pieces = makePieces("shoreditch london")
		const matrix = buildPlacetypePairPriors({ index }, pieces, LABELS)

		for (const row of matrix) {
			expect(row.every((v) => v === 0)).toBe(true)
		}
		expect(index.calls.length).toBeGreaterThan(0) // it DID probe — just never hit
	})
})

describe("buildPlacetypePairPriors — window-key fold (space-join, not concatenation)", () => {
	it('probes a 2-word window as "st helens" (space-joined), never "sthelens"', async () => {
		// Real fixture tokenizer split for "St Helens Lancashire": ['▁St','▁Hel','ens','▁Lan','ca','shire']
		// — "Helens" is genuinely two SentencePiece pieces here, so this exercises normalizeFSTToken's
		// fold-then-join pipeline against a real multi-piece word, not a hand-rolled approximation. A
		// third word ("Lancashire") is needed so the 2-word "St Helens" window has a disjoint partner to
		// probe against — with only two words total there's no room left for any pairing.
		const tokenizer = await MailwomanTokenizer.loadFromFile(
			repoRootPath("neural", "test", "fixtures", "tokenizer-v0.1.0.model")
		)
		const { pieces } = tokenizer.encode("St Helens Lancashire")
		const index = mockPairIndex({ "st helens|lancashire": "dependent_locality" }, 6.0)

		const matrix = buildPlacetypePairPriors({ index }, pieces, LABELS)

		// The 2-word window "St Helens" must have been probed as the space-joined fold. A naive
		// concatenation ("sthelens") would never appear in the real index and this assertion would fail.
		expect(index.calls.some(([child]) => child === "st helens")).toBe(true)
		expect(index.calls.some(([child]) => child === "sthelens")).toBe(false)
		// And the match actually fires: "St"'s piece (idx 0, the window's first piece) gets the bias.
		expect(matrix[0]![labelCol("B-dependent_locality")]).toBe(6.0)
	})
})

describe("buildPlacetypePairPriors — matrix-cell exactness", () => {
	it("biases the child window's B-tag (first piece) / I-tag (rest) toward the resolved tag", () => {
		const index = mockPairIndex({ "shoreditch|london": "dependent_locality" }, 6.0)
		const pieces = makePieces("shoreditch london") // pieces[0]=shoreditch, pieces[1]=london
		const matrix = buildPlacetypePairPriors({ index }, pieces, LABELS)

		expect(matrix[0]![labelCol("B-dependent_locality")]).toBe(6.0)
		// Single-piece window: no I- piece to write, and no OTHER cell on piece 0 should move.
		expect(matrix[0]!.filter((v) => v !== 0)).toHaveLength(1)
		// "london" never resolves as a child of anything in this index — untouched.
		expect(matrix[1]!.every((v) => v === 0)).toBe(true)
	})

	it("writes B- on the first piece and I- on every subsequent piece of a multi-piece window", () => {
		// "new york" as a 2-word CHILD window (3 pieces total across the two words) under parent "ny".
		const index = mockPairIndex({ "new york|ny": "locality" }, 4.0)
		const pieces = makePieces("new york ny") // pieces[0]=new, pieces[1]=york, pieces[2]=ny
		const matrix = buildPlacetypePairPriors({ index }, pieces, LABELS)

		expect(matrix[0]![labelCol("B-locality")]).toBe(4.0)
		expect(matrix[1]![labelCol("I-locality")]).toBe(4.0)
	})

	it("resolves the bias magnitude from index.delta, falling back to biasScale when delta is absent", () => {
		const withDelta = mockPairIndex({ "shoreditch|london": "dependent_locality" }, 6.0)
		const withoutDelta = mockPairIndex({ "shoreditch|london": "dependent_locality" }, undefined)
		const pieces = makePieces("shoreditch london")

		const a = buildPlacetypePairPriors({ index: withDelta, biasScale: 9.9 }, pieces, LABELS)
		const b = buildPlacetypePairPriors({ index: withoutDelta, biasScale: 2.5 }, pieces, LABELS)

		expect(a[0]![labelCol("B-dependent_locality")]).toBe(6.0) // index.delta wins over biasScale
		expect(b[0]![labelCol("B-dependent_locality")]).toBe(2.5) // biasScale is the fallback
	})
})

describe("buildPlacetypePairPriors — comma-free multi-word parent (3-word window, N=3)", () => {
	it('matches child "fishburn" against the 3-word parent window "stockton on tees"', () => {
		const index = mockPairIndex({ "fishburn|stockton on tees": "dependent_locality" }, 6.0)
		const pieces = makePieces("fishburn stockton on tees")
		const matrix = buildPlacetypePairPriors({ index }, pieces, LABELS)

		// pieces[0] = "fishburn" (the child, 1-word window)
		expect(matrix[0]![labelCol("B-dependent_locality")]).toBe(6.0)
		// The 3-word parent window itself never resolves as a CHILD of anything in this index.
		expect(matrix[1]!.every((v) => v === 0)).toBe(true)
		expect(matrix[2]!.every((v) => v === 0)).toBe(true)
		expect(matrix[3]!.every((v) => v === 0)).toBe(true)
	})
})

describe("buildPlacetypePairPriors — marker suppression", () => {
	it('suppresses a window immediately followed by a structural marker ("road") — no bias even though it would match', () => {
		const index = mockPairIndex({ "church|sometown": "dependent_locality" }, 6.0)
		const pieces = makePieces("church road sometown")
		const matrix = buildPlacetypePairPriors({ index }, pieces, LABELS)

		// "church" is immediately followed by "road" (a structural marker: street-suffix reading, e.g.
		// "Church Road") — the window must never even be probed as a candidate child.
		expect(matrix[0]!.every((v) => v === 0)).toBe(true)
	})

	it("the SAME child/parent pair DOES bias when no marker sits between them", () => {
		const index = mockPairIndex({ "church|sometown": "dependent_locality" }, 6.0)
		const pieces = makePieces("church sometown") // no marker word in between
		const matrix = buildPlacetypePairPriors({ index }, pieces, LABELS)

		expect(matrix[0]![labelCol("B-dependent_locality")]).toBe(6.0)
	})

	it("suppresses a window immediately followed by a house-number-shaped token", () => {
		const index = mockPairIndex({ "flat|sometown": "dependent_locality" }, 6.0)
		const pieces = makePieces("flat 5 sometown")
		const matrix = buildPlacetypePairPriors({ index }, pieces, LABELS)

		expect(matrix[0]!.every((v) => v === 0)).toBe(true)
	})
})

describe("buildPlacetypePairPriors — disjointness", () => {
	it("never pairs two OVERLAPPING candidate windows, even when the index has an entry for that exact pair", () => {
		// A contrived index entry keyed on two windows that would overlap ("a b" / "b c" both cover the
		// middle word "b") — the disjointness rule must reject this pairing regardless.
		const index = mockPairIndex({ "a b|b c": "locality" }, 6.0)
		const pieces = makePieces("a b c")
		const matrix = buildPlacetypePairPriors({ index }, pieces, LABELS)

		for (const row of matrix) {
			expect(row.every((v) => v === 0)).toBe(true)
		}
	})
})
