/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The JS k-best decode is verified against BRUTE-FORCE enumeration of every valid segmentation, the
 *   same discipline the python side got (`tests/mailwoman_train/test_span_scorer.py`). A DP that is
 *   subtly wrong still returns plausible-looking spans — the oracle is the point.
 */

import { describe, expect, it } from "vitest"

import { decodeSegmentationsKBest, parseSemiCRFTransitions, type SemiCRFTransitions } from "./semi-markov-decode.ts"

const TYPES = ["O", "street", "locality"]

function grammar(overrides: Partial<SemiCRFTransitions> = {}): SemiCRFTransitions {
	const n = TYPES.length

	return {
		segmentTypes: TYPES,
		maxSpan: 2,
		transitions: Array.from({ length: n }, () => new Array(n).fill(0)),
		startTransitions: new Array(n).fill(0),
		endTransitions: new Array(n).fill(0),
		...overrides,
	}
}

/** Deterministic pseudo-random scores — a fixed table beats a seeded RNG for reproducibility. */
function scores(seqLen: number, maxSpan: number, seed = 1): number[][][] {
	let s = seed

	const next = (): number => {
		s = (s * 1103515245 + 12345) % 2147483648

		return (s / 2147483648) * 4 - 2
	}

	return Array.from({ length: seqLen }, () =>
		Array.from({ length: maxSpan }, () => Array.from({ length: TYPES.length }, () => next()))
	)
}

/** Every valid segmentation of [0, seqLen) — O segments length 1, others up to maxSpan. */
function bruteForce(seqLen: number, maxSpan: number): Array<Array<[number, number, number]>> {
	const out: Array<Array<[number, number, number]>> = []

	const rec = (pos: number, acc: Array<[number, number, number]>): void => {
		if (pos === seqLen) {
			out.push([...acc])

			return
		}

		for (let len = 1; len <= Math.min(maxSpan, seqLen - pos); len++) {
			for (let t = 0; t < TYPES.length; t++) {
				if (t === 0 && len !== 1) continue
				acc.push([pos, len, t])
				rec(pos + len, acc)
				acc.pop()
			}
		}
	}
	rec(0, [])

	return out
}

function scoreOne(seg: Array<[number, number, number]>, sc: number[][][], g: SemiCRFTransitions): number {
	let total = 0
	let prev = -1

	for (const [i, len, t] of seg) {
		total += sc[i]![len - 1]![t]!
		total += prev === -1 ? g.startTransitions[t]! : g.transitions[prev]![t]!
		prev = t
	}

	return total + g.endTransitions[prev]!
}

describe("decodeSegmentationsKBest", () => {
	it("rank-1 matches the brute-force argmax", () => {
		const g = grammar({
			transitions: [
				[0.1, -0.4, 0.9],
				[0.5, 0.2, -0.3],
				[-0.2, 0.7, 0.1],
			],
			startTransitions: [0.3, -0.1, 0.6],
			endTransitions: [-0.5, 0.4, 0.2],
		})
		const sc = scores(4, 2, 7)
		const got = decodeSegmentationsKBest(sc, 4, g, 1)[0]!
		const all = bruteForce(4, 2)
		const best = all.reduce((a, b) => (scoreOne(b, sc, g) > scoreOne(a, sc, g) ? b : a))
		expect(got.score).toBeCloseTo(scoreOne(best, sc, g), 6)
		expect(got.segments.map((s) => [s.start, s.length, s.typeID])).toEqual(best)
	})

	it("the k-best LIST matches the brute-force top-k, in order", () => {
		const g = grammar({
			transitions: [
				[0.2, 0.6, -0.3],
				[-0.1, 0.4, 0.8],
				[0.3, -0.5, 0.15],
			],
			startTransitions: [0.1, 0.5, -0.2],
			endTransitions: [0.25, -0.3, 0.45],
		})
		const sc = scores(4, 2, 11)
		const k = 5
		const got = decodeSegmentationsKBest(sc, 4, g, k)
		const expected = bruteForce(4, 2)
			.map((s) => scoreOne(s, sc, g))
			.sort((a, b) => b - a)
			.slice(0, k)
		expect(got).toHaveLength(k)
		got.forEach((h, i) => expect(h.score).toBeCloseTo(expected[i]!, 6))
	})

	it("scores are descending — the reranker relies on rank order", () => {
		const g = grammar()
		const got = decodeSegmentationsKBest(scores(5, 2, 3), 5, g, 8)

		for (let i = 1; i < got.length; i++) {
			expect(got[i - 1]!.score).toBeGreaterThanOrEqual(got[i]!.score)
		}
	})

	it("every hypothesis covers the sequence exactly — no gap, no overlap", () => {
		const got = decodeSegmentationsKBest(scores(6, 3, 5), 6, grammar({ maxSpan: 3 }), 6)
		expect(got.length).toBeGreaterThan(0)

		for (const h of got) {
			const covered = h.segments.flatMap((s) => Array.from({ length: s.length }, (_, i) => s.start + i))
			expect(covered).toEqual([0, 1, 2, 3, 4, 5])
		}
	})

	it("never emits a multi-token O even when the scores beg for it", () => {
		const sc = scores(6, 3, 9)

		for (const perLen of sc) {
			for (const row of perLen) {
				row[0] = 100
			}
		}

		for (const h of decodeSegmentationsKBest(sc, 6, grammar({ maxSpan: 3 }), 3)) {
			for (const s of h.segments)
				if (s.typeID === 0) {
					expect(s.length).toBe(1)
				}
		}
	})

	it("k=1 returns exactly one hypothesis", () => {
		expect(decodeSegmentationsKBest(scores(4, 2, 13), 4, grammar(), 1)).toHaveLength(1)
	})

	it("respects a maxSpan narrower than the score tensor", () => {
		// Grammar says 1; the tensor offers 3. Nothing longer than 1 may be emitted.
		for (const h of decodeSegmentationsKBest(scores(4, 3, 17), 4, grammar({ maxSpan: 1 }), 4)) {
			for (const s of h.segments) {
				expect(s.length).toBe(1)
			}
		}
	})
})

describe("parseSemiCRFTransitions", () => {
	const valid = {
		segment_types: ["O", "street"],
		max_span: 4,
		transitions: [
			[0, 1],
			[2, 3],
		],
		start_transitions: [0, 1],
		end_transitions: [1, 0],
	}

	it("parses the sidecar and carries the axis through", () => {
		const g = parseSemiCRFTransitions(valid)
		expect(g.segmentTypes).toEqual(["O", "street"])
		expect(g.maxSpan).toBe(4)
		expect(g.transitions[1]![0]).toBe(2)
	})

	it("throws on a transition matrix that disagrees with segment_types", () => {
		expect(() => parseSemiCRFTransitions({ ...valid, transitions: [[0, 1]] })).toThrow(/2x2/)
	})

	it("throws when segment_types[0] is not O — the decoder's length rule depends on it", () => {
		expect(() => parseSemiCRFTransitions({ ...valid, segment_types: ["street", "O"] })).toThrow(/must be "O"/)
	})

	it("throws on a missing max_span rather than defaulting", () => {
		const { max_span: _drop, ...rest } = valid
		expect(() => parseSemiCRFTransitions(rest)).toThrow(/max_span/)
	})
})
