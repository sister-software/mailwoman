/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import {
	buildBIOEndMask,
	buildBIOStartMask,
	buildBIOTransitionMask,
	perTokenArgmax,
	softmax,
	viterbi,
} from "./viterbi.js"

const NEG_INF = -1e9
const LABELS = ["O", "B-locality", "I-locality", "B-region", "I-region"] as const

describe("buildBIOTransitionMask", () => {
	it("permits O → anything except I-X", () => {
		const mask = buildBIOTransitionMask(LABELS)
		expect(mask[0]?.[0]).toBe(0) // O → O
		expect(mask[0]?.[1]).toBe(0) // O → B-locality
		expect(mask[0]?.[2]).toBe(NEG_INF) // O → I-locality (forbidden)
		expect(mask[0]?.[3]).toBe(0) // O → B-region
		expect(mask[0]?.[4]).toBe(NEG_INF) // O → I-region (forbidden)
	})

	it("permits B-X → I-X but forbids B-X → I-Y for different tags", () => {
		const mask = buildBIOTransitionMask(LABELS)
		// from = B-locality (idx 1)
		expect(mask[1]?.[2]).toBe(0) // B-locality → I-locality
		expect(mask[1]?.[4]).toBe(NEG_INF) // B-locality → I-region
		expect(mask[1]?.[0]).toBe(0) // B-locality → O
		expect(mask[1]?.[1]).toBe(0) // B-locality → B-locality
	})

	it("permits I-X → I-X", () => {
		const mask = buildBIOTransitionMask(LABELS)
		expect(mask[2]?.[2]).toBe(0) // I-locality → I-locality
	})
})

describe("buildBIOStartMask", () => {
	it("forbids starting on I-X", () => {
		const start = buildBIOStartMask(LABELS)
		expect(start[0]).toBe(0) // O
		expect(start[1]).toBe(0) // B-locality
		expect(start[2]).toBe(NEG_INF) // I-locality
		expect(start[3]).toBe(0) // B-region
		expect(start[4]).toBe(NEG_INF) // I-region
	})
})

describe("viterbi — basic", () => {
	it("returns empty path for empty input", () => {
		const result = viterbi({ emissions: [], transitions: [] })
		expect(result.path).toEqual([])
	})

	it("picks the obvious single-token best", () => {
		// One timestep, B-locality has highest emission.
		const result = viterbi({
			emissions: [[-1, 5, -10, -10, -10]],
			transitions: buildBIOTransitionMask(LABELS),
		})
		expect(result.path).toEqual([1]) // B-locality
	})

	it("prevents O → I-X (orphan-I sequence)", () => {
		// Naive argmax would pick: O, I-locality (because emission for I-locality is highest at t=1)
		// Viterbi with structural mask must pick something else valid.
		const emissions = [
			[5, -1, -10, -10, -10], // t=0: O wins
			[-1, -1, 5, -10, -10], // t=1: I-locality wins naively, but invalid after O
		]
		const path = viterbi({
			emissions,
			transitions: buildBIOTransitionMask(LABELS),
			startTransitions: buildBIOStartMask(LABELS),
		}).path

		// Verify no orphan-I.
		for (let t = 1; t < path.length; t++) {
			const cur = LABELS[path[t]!]!
			const prev = LABELS[path[t - 1]!]!

			if (cur.startsWith("I-")) {
				const tag = cur.slice(2)
				expect(prev === `B-${tag}` || prev === `I-${tag}`).toBe(true)
			}
		}
	})

	it("recovers the Saint Petersburg pattern (B-locality I-locality)", () => {
		// emissions[0] = "Saint", uncertain between O and B-locality
		// emissions[1] = "Petersburg", confident I-locality
		// Naive argmax: O, I-locality (invalid)
		// Viterbi: B-locality, I-locality (valid + globally best)
		const emissions = [
			[0.45, 0.4, 0.1, 0.05, 0.0], // O, B-loc, I-loc, B-reg, I-reg
			[0.1, 0.2, 0.65, 0.05, 0.0],
		]
		const path = viterbi({
			emissions,
			transitions: buildBIOTransitionMask(LABELS),
			startTransitions: buildBIOStartMask(LABELS),
		}).path
		expect(LABELS[path[0]!]).toBe("B-locality")
		expect(LABELS[path[1]!]).toBe("I-locality")
	})

	it("falls back gracefully when emissions strongly contradict structural rules", () => {
		// All emissions favor I-locality. Viterbi must still produce a structurally valid sequence.
		const emissions = [
			[0.01, 0.01, 0.97, 0.005, 0.005],
			[0.01, 0.01, 0.97, 0.005, 0.005],
		]
		const path = viterbi({
			emissions,
			transitions: buildBIOTransitionMask(LABELS),
			startTransitions: buildBIOStartMask(LABELS),
			endTransitions: buildBIOEndMask(LABELS),
		}).path
		// First label can't be I-locality (start mask forbids).
		expect(LABELS[path[0]!]).not.toBe("I-locality")
	})

	it("agrees with argmax when transitions are all zero (no structural constraints)", () => {
		const allZero = LABELS.map(() => LABELS.map(() => 0))
		const emissions = [
			[0.1, 0.5, 0.1, 0.2, 0.1],
			[0.7, 0.05, 0.05, 0.1, 0.1],
			[0.1, 0.1, 0.1, 0.6, 0.1],
		]
		const viterbiPath = viterbi({
			emissions,
			transitions: allZero,
			startTransitions: LABELS.map(() => 0),
			endTransitions: LABELS.map(() => 0),
		}).path
		const argmaxPath = perTokenArgmax(emissions)
		expect(viterbiPath).toEqual(argmaxPath)
	})
})

describe("perTokenArgmax", () => {
	it("picks the max per row", () => {
		expect(perTokenArgmax([[0.1, 0.5, 0.4]])).toEqual([1])
	})

	it("handles ties by picking the first", () => {
		expect(perTokenArgmax([[0.5, 0.5, 0.0]])).toEqual([0])
	})
})

describe("softmax", () => {
	it("produces probabilities summing to 1", () => {
		const p = softmax([1, 2, 3])
		const sum = p.reduce((a, b) => a + b, 0)
		expect(sum).toBeCloseTo(1, 6)
	})

	it("is numerically stable on large logits", () => {
		const p = softmax([1000, 1001, 1002])
		const sum = p.reduce((a, b) => a + b, 0)
		expect(sum).toBeCloseTo(1, 6)
	})

	it("preserves order", () => {
		const p = softmax([1, 2, 3])
		expect(p[0]).toBeLessThan(p[1]!)
		expect(p[1]).toBeLessThan(p[2]!)
	})
})
