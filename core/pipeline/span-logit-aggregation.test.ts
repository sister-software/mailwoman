/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"
import { aggregateSpanLogits, type SpanBounds, type TokenPiece } from "./span-logit-aggregation.js"

// Minimal 5-label vocab for testing: O, B-locality, I-locality, B-region, I-region
const LABELS = ["O", "B-locality", "I-locality", "B-region", "I-region"]

// Helper: build logits where one label is dominant (high value) for a token.
function dominantLogits(numLabels: number, dominantIdx: number, dominantValue = 5.0, otherValue = -1.0): number[] {
	return Array.from({ length: numLabels }, (_, i) => (i === dominantIdx ? dominantValue : otherValue))
}

describe("aggregateSpanLogits", () => {
	it("produces per-span top-K candidates from per-token logits", () => {
		// Two tokens: token 0 strongly predicts B-locality, token 1 strongly predicts I-locality
		const pieces: TokenPiece[] = [
			{ start: 0, end: 5 },
			{ start: 5, end: 10 },
		]
		const logits = [
			dominantLogits(5, 1), // B-locality dominant
			dominantLogits(5, 2), // I-locality dominant
		]
		const spans: SpanBounds[] = [{ start: 0, end: 10 }]

		const candidates = aggregateSpanLogits(logits, pieces, spans, { topK: 3, labels: LABELS })

		expect(candidates.length).toBeGreaterThan(0)
		expect(candidates[0]!.tag).toBe("locality")
		expect(candidates[0]!.score).toBeGreaterThan(0.5)
		expect(candidates[0]!.span).toEqual({ start: 0, end: 10 })
	})

	it("merges B-tag and I-tag scores into the same component tag", () => {
		// Token 0: B-region strong, Token 1: I-region strong → region should dominate
		const pieces: TokenPiece[] = [
			{ start: 0, end: 3 },
			{ start: 3, end: 6 },
		]
		const logits = [
			dominantLogits(5, 3), // B-region
			dominantLogits(5, 4), // I-region
		]
		const spans: SpanBounds[] = [{ start: 0, end: 6 }]

		const candidates = aggregateSpanLogits(logits, pieces, spans, { topK: 2, labels: LABELS })

		const regionCandidate = candidates.find((c) => c.tag === "region")
		expect(regionCandidate).toBeDefined()
		expect(regionCandidate!.score).toBeGreaterThan(0.5)
	})

	it("returns multiple spans independently", () => {
		// Two spans covering different tokens
		const pieces: TokenPiece[] = [
			{ start: 0, end: 5 },
			{ start: 6, end: 11 },
		]
		const logits = [
			dominantLogits(5, 1), // B-locality
			dominantLogits(5, 3), // B-region
		]
		const spans: SpanBounds[] = [
			{ start: 0, end: 5 },
			{ start: 6, end: 11 },
		]

		const candidates = aggregateSpanLogits(logits, pieces, spans, { topK: 1, labels: LABELS })

		expect(candidates.length).toBe(2)
		expect(candidates[0]!.tag).toBe("locality")
		expect(candidates[1]!.tag).toBe("region")
	})

	it("ignores O label — does not produce an O candidate", () => {
		// Token strongly predicts O
		const pieces: TokenPiece[] = [{ start: 0, end: 5 }]
		const logits = [dominantLogits(5, 0)] // O dominant
		const spans: SpanBounds[] = [{ start: 0, end: 5 }]

		const candidates = aggregateSpanLogits(logits, pieces, spans, { topK: 3, labels: LABELS })

		const oCandidate = candidates.find((c) => c.tag === "O")
		expect(oCandidate).toBeUndefined()
	})

	it("normalizes by token count so longer spans don't auto-dominate", () => {
		// 1-token span vs 3-token span with same per-token confidence → same score
		const pieces: TokenPiece[] = [
			{ start: 0, end: 3 },
			{ start: 3, end: 6 },
			{ start: 6, end: 9 },
			{ start: 10, end: 13 },
		]
		const logits = [
			dominantLogits(5, 1), // B-locality
			dominantLogits(5, 2), // I-locality
			dominantLogits(5, 2), // I-locality
			dominantLogits(5, 1), // B-locality
		]
		const spans: SpanBounds[] = [
			{ start: 0, end: 9 }, // 3 tokens
			{ start: 10, end: 13 }, // 1 token
		]

		const candidates = aggregateSpanLogits(logits, pieces, spans, { topK: 1, labels: LABELS })

		const span1 = candidates.find((c) => c.span.start === 0)!
		const span2 = candidates.find((c) => c.span.start === 10)!
		// Both should score high for locality; the 3-token span shouldn't be 3× higher
		expect(Math.abs(span1.score - span2.score)).toBeLessThan(0.3)
	})

	it("returns empty array when no spans overlap tokens", () => {
		const pieces: TokenPiece[] = [{ start: 0, end: 5 }]
		const logits = [dominantLogits(5, 1)]
		const spans: SpanBounds[] = [{ start: 100, end: 110 }]

		const candidates = aggregateSpanLogits(logits, pieces, spans, { labels: LABELS })
		expect(candidates).toEqual([])
	})
})
