/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for `rerankByStreetEvidence` (#727 phase-4c wiring). Drives real k-best hypotheses through
 *   a hand-built grammar + spanScores, a mock classifier trace, and a mock evidence provider —
 *   covering the byte-stable no-span-head fallback, the G1-skip → move correction, and the tree
 *   re-materialization on a move.
 */

import { decodeAsJSON } from "@mailwoman/core/decoder"
import type { NeuralAddressClassifier, NeuralParseTrace, SemiCRFTransitions } from "@mailwoman/neural"
import { foldStreetSurface, type StreetLocalityEvidence } from "@mailwoman/resolver"
import { describe, expect, test } from "vitest"

import { rerankByStreetEvidence } from "./kbest-street-rerank.ts"

const TYPES = ["O", "street", "locality"]

const grammar = (): SemiCRFTransitions => {
	const n = TYPES.length

	return {
		segmentTypes: TYPES,
		maxSpan: 2,
		transitions: Array.from({ length: n }, () => new Array(n).fill(0)),
		startTransitions: new Array(n).fill(0),
		endTransitions: new Array(n).fill(0),
	}
}

/** A trace over "Rue Corsier" (2 tokens). `spanScores` optional — omit to exercise the fallback. */
const trace = (spanScores?: number[][][]): NeuralParseTrace =>
	({
		text: "Rue Corsier",
		tokens: [
			{ piece: "Rue", start: 0, end: 3, label: "B-street", confidence: 0.9 },
			{ piece: "Corsier", start: 4, end: 11, label: "I-street", confidence: 0.9 },
		],
		...(spanScores ? { spanScores } : {}),
	}) as unknown as NeuralParseTrace

const mockClassifier = (t: NeuralParseTrace): NeuralAddressClassifier =>
	({ traceParse: async () => t }) as unknown as NeuralAddressClassifier

const mockEvidence = (existing: string[]): StreetLocalityEvidence => {
	const set = new Set(existing.map(foldStreetSurface))

	return { countries: new Set(["FR"]), hasStreetName: (s) => set.has(foldStreetSurface(s)) }
}

/**
 * SpanScores[token][length-1][type]. Tuned so the top-2 k-best are: H1 (rank-1, score 10): street "Rue" (0,1) +
 * locality "Corsier" (1,1) H2 (rank-2, score 8): street "Rue Corsier" (0,2) margin 2 ≤ 2.5 (G2 ok). Everything else
 * deeply negative.
 */
const NEG = -100

function tunedSpanScores(): number[][][] {
	// token 0: [len1: [O,street,loc]], [len2: [O,street,loc]]
	// token 1: [len1: [O,street,loc]], [len2 unused (would overflow)]
	const s: number[][][] = [
		[
			[NEG, 5, NEG], // token0 len1: street=5
			[NEG, 8, NEG], // token0 len2: street "Rue Corsier"=8
		],
		[
			[NEG, NEG, 5], // token1 len1: locality "Corsier"=5
			[NEG, NEG, NEG], // token1 len2: out of range
		],
	]

	return s
}

describe("rerankByStreetEvidence", () => {
	test("byte-stable fallback: no span head → the argmax tree, not moved", async () => {
		const t = trace() // no spanScores
		const res = await rerankByStreetEvidence(mockClassifier(t), "Rue Corsier", mockEvidence([]), grammar())
		expect(res.moved).toBe(false)
		expect(res.rank).toBe(0)
		// The argmax tokens label both as street → the tree's street is the full surface.
		expect(decodeAsJSON(res.tree).street).toBe("Rue Corsier")
	})

	test("G1-skip → MOVE: rank-1 street 'Rue' is pure-type, evidence promotes rank-2 'Rue Corsier'", async () => {
		const t = trace(tunedSpanScores())
		const res = await rerankByStreetEvidence(mockClassifier(t), "Rue Corsier", mockEvidence(["Rue Corsier"]), grammar())
		expect(res.moved).toBe(true)
		expect(res.rank).toBe(1)
		expect(foldStreetSurface(res.streetSurface)).toBe("rue corsier")
		// The re-materialized tree carries the winning segmentation's street.
		expect(decodeAsJSON(res.tree).street).toBe("Rue Corsier")
	})

	test("fail-open: nothing in the index → keep rank-1 (not moved)", async () => {
		const t = trace(tunedSpanScores())
		const res = await rerankByStreetEvidence(mockClassifier(t), "Rue Corsier", mockEvidence([]), grammar())
		expect(res.moved).toBe(false)
		expect(res.rank).toBe(0)
	})
})
