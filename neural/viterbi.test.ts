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
} from "./viterbi.ts"

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

describe("viterbi — position-scoped transition adjustments (TRANSITION-BETA)", () => {
	// The path-fusion lattice from the task-8 transition-level probe, miniaturized: a 3-token input
	// where the FUSED run (B-locality → I-locality → I-locality) outscores the desired split
	// (B-locality → B-region → O is irrelevant here — the competing reading is B-region entered at
	// t=1) by a margin smaller than the bonus. The emission at t=1 already favors B-region locally
	// (4 > 3), yet the global path stays fused because switching costs the continuation at t=2
	// (I-region 0 vs I-locality 5). This is the exact mechanism the adjustment exists for.
	const FUSION_EMISSIONS = [
		[0, 6, NEG_INF, 0, NEG_INF], // t=0: B-locality 6
		[0, 0, 3, 4, NEG_INF], // t=1: I-locality 3 vs B-region 4 — local win for B-region
		[0, 0, 5, 0, 1], // t=2: I-locality 5 vs I-region 1 — the continuation toll
	]
	// Fused: 6 + 3 + 5 = 14. Split (B-loc, B-reg, I-reg): 6 + 4 + 1 = 11 — margin 3.

	it("a bonus on the entry transition flips a fused path (before/after on the same lattice)", () => {
		const base = viterbi({
			emissions: FUSION_EMISSIONS,
			transitions: buildBIOTransitionMask(LABELS),
			startTransitions: buildBIOStartMask(LABELS),
		})
		expect(base.path.map((k) => LABELS[k])).toEqual(["B-locality", "I-locality", "I-locality"])

		const boosted = viterbi({
			emissions: FUSION_EMISSIONS,
			transitions: buildBIOTransitionMask(LABELS),
			startTransitions: buildBIOStartMask(LABELS),
			// +4 into B-region at t=1: split path 11 + 4 = 15 > 14 — flips.
			transitionAdjustments: [{ timestep: 1, toLabel: 3, bonus: 4 }],
		})
		expect(boosted.path.map((k) => LABELS[k])).toEqual(["B-locality", "B-region", "I-region"])
		expect(boosted.score).toBeCloseTo(15, 6)
	})

	it("a bonus below the fusion margin does NOT flip — the adjustment is additive, not a constraint", () => {
		const under = viterbi({
			emissions: FUSION_EMISSIONS,
			transitions: buildBIOTransitionMask(LABELS),
			startTransitions: buildBIOStartMask(LABELS),
			transitionAdjustments: [{ timestep: 1, toLabel: 3, bonus: 2 }], // 11 + 2 = 13 < 14
		})
		expect(under.path.map((k) => LABELS[k])).toEqual(["B-locality", "I-locality", "I-locality"])
	})

	it("an adjustment at timestep 0 lands on the start transition", () => {
		const emissions = [
			[0, 3, NEG_INF, 1, NEG_INF], // B-locality 3 vs B-region 1
			[5, 0, 0, 0, 0], // O everywhere after
		]
		const base = viterbi({
			emissions,
			transitions: buildBIOTransitionMask(LABELS),
			startTransitions: buildBIOStartMask(LABELS),
		})
		expect(LABELS[base.path[0]!]).toBe("B-locality")

		const boosted = viterbi({
			emissions,
			transitions: buildBIOTransitionMask(LABELS),
			startTransitions: buildBIOStartMask(LABELS),
			transitionAdjustments: [{ timestep: 0, toLabel: 3, bonus: 3 }], // B-region 1 + 3 = 4 > 3
		})
		expect(LABELS[boosted.path[0]!]).toBe("B-region")
	})

	it("a bonus cannot resurrect a structurally forbidden transition (NEG_INF + bonus stays effectively -inf)", () => {
		const emissions = [
			[5, 0, NEG_INF, 0, NEG_INF], // t=0: O
			[0, 0, 10, 0, 0], // t=1: I-locality wins on emissions — but O → I-locality is forbidden
		]
		const boosted = viterbi({
			emissions,
			transitions: buildBIOTransitionMask(LABELS),
			startTransitions: buildBIOStartMask(LABELS),
			transitionAdjustments: [{ timestep: 1, toLabel: 2, bonus: 50 }],
		})

		// Whatever wins, it is not an orphan I-locality after O.
		expect(boosted.path.map((k) => LABELS[k])).not.toEqual(["O", "I-locality"])
	})

	it("duplicate adjustments on the same (timestep, toLabel) cell compose by max, not sum", () => {
		const withDupes = viterbi({
			emissions: FUSION_EMISSIONS,
			transitions: buildBIOTransitionMask(LABELS),
			startTransitions: buildBIOStartMask(LABELS),
			// Two entries of 2 each: summed (4) would flip, max'd (2) must not.
			transitionAdjustments: [
				{ timestep: 1, toLabel: 3, bonus: 2 },
				{ timestep: 1, toLabel: 3, bonus: 2 },
			],
		})
		expect(withDupes.path.map((k) => LABELS[k])).toEqual(["B-locality", "I-locality", "I-locality"])
	})

	it("an empty adjustment list decodes byte-identically to omitting the field", () => {
		const without = viterbi({
			emissions: FUSION_EMISSIONS,
			transitions: buildBIOTransitionMask(LABELS),
			startTransitions: buildBIOStartMask(LABELS),
		})
		const withEmpty = viterbi({
			emissions: FUSION_EMISSIONS,
			transitions: buildBIOTransitionMask(LABELS),
			startTransitions: buildBIOStartMask(LABELS),
			transitionAdjustments: [],
		})
		expect(withEmpty.path).toEqual(without.path)
		expect(withEmpty.score).toBe(without.score)
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
