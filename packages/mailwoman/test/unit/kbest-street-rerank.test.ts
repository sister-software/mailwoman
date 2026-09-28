/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for `rerankByStreetEvidence`. Drives real k-best hypotheses through a hand-built grammar
 *   and spanScores plus a mock classifier trace and mock evidence provider.
 *   The tests cover the byte-stable no-span-head fallback, the G1-skip move correction and tree re-materialization on a move.
 */

import { decodeAsJSON } from "@mailwoman/core/decoder"
import type { NeuralAddressClassifier, NeuralParseTrace, SemiCRFTransitions } from "@mailwoman/neural"
import { foldStreetSurface, type StreetLocalityEvidence } from "@mailwoman/resolver"
import { rerankByStreetEvidence } from "mailwoman/kbest-street-rerank"
import { describe, expect, test } from "vitest"

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

/**
 * A trace over "Rue Corsier" (2 tokens).
 *
 * `spanScores` is optional.
 * The test exercises the fallback when the value is absent.
 */
const trace = (spanScores?: number[][][]): NeuralParseTrace =>
	({
		text: "Rue Corsier",
		tokens: [
			{ piece: "Rue", start: 0, end: 3, label: "B-street", confidence: 0.9 },
			{ piece: "Corsier", start: 4, end: 11, label: "I-street", confidence: 0.9 },
		],
		...(spanScores ? { spanScores } : {}),
	}) as NeuralParseTrace

const mockClassifier = (t: NeuralParseTrace): Pick<NeuralAddressClassifier, "traceParse"> => ({
	traceParse: async () => t,
})

const mockEvidence = (existing: string[]): StreetLocalityEvidence => {
	const set = new Set(existing.map(foldStreetSurface))

	return { countries: new Set(["FR"]), hasStreetName: (s) => set.has(foldStreetSurface(s)) }
}

/**
 * SpanScores are indexed as `[token][length-1][type]`, tuned so the top two k-best are
 * the rank-1 split and the rank-2 full street with a margin inside 2.5.
 */
const NEG = -100

function tunedSpanScores(): number[][][] {
	const s: number[][][] = [
		[
			[NEG, 5, NEG],
			[NEG, 8, NEG],
		],
		[
			[NEG, NEG, 5],
			[NEG, NEG, NEG],
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
		expect(decodeAsJSON(res.tree).street).toBe("Rue Corsier")
	})

	test("G1-skip → MOVE: rank-1 street 'Rue' is pure-type, evidence promotes rank-2 'Rue Corsier'", async () => {
		const t = trace(tunedSpanScores())
		const res = await rerankByStreetEvidence(mockClassifier(t), "Rue Corsier", mockEvidence(["Rue Corsier"]), grammar())
		expect(res.moved).toBe(true)
		expect(res.rank).toBe(1)
		expect(foldStreetSurface(res.streetSurface)).toBe("rue corsier")
		expect(decodeAsJSON(res.tree).street).toBe("Rue Corsier")
	})

	test("fail-open: nothing in the index → keep rank-1 (not moved)", async () => {
		const t = trace(tunedSpanScores())
		const res = await rerankByStreetEvidence(mockClassifier(t), "Rue Corsier", mockEvidence([]), grammar())
		expect(res.moved).toBe(false)
		expect(res.rank).toBe(0)
	})

	test("anchor check: an argmax region anchor makes the rerank stand down even with a confirmed move", async () => {
		// The rerank must not steal the region-labeled token.
		const t = trace(tunedSpanScores())
		t.tokens[1] = { ...t.tokens[1]!, label: "B-region" }
		const res = await rerankByStreetEvidence(mockClassifier(t), "Rue Corsier", mockEvidence(["Rue Corsier"]), grammar())
		expect(res.moved).toBe(false)
		expect(res.rank).toBe(0)
	})
})
