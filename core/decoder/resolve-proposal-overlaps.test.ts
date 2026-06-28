/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   #478 increment 3 — the coherence pass. Verifies `resolveProposalOverlaps` produces a
 *   non-overlapping set (the invariant `proposalsToTree` needs) and that the selection policy
 *   (confidence desc → finer span → earlier start) preserves the street+house_number
 *   decomposition.
 */

import { Span } from "@mailwoman/core/tokenization"
import type { ClassificationProposal, ComponentTag } from "@mailwoman/core/types"
import { describe, expect, test } from "vitest"

import { resolveProposalOverlaps } from "./resolve-proposal-overlaps.js"

/** Build a proposal with an explicit span (`new Span(body, start)` derives `end = start + len`). */
function p(component: ComponentTag, body: string, start: number, confidence: number): ClassificationProposal {
	return {
		span: new Span(body, start),
		component,
		confidence,
		source: "neural",
		source_id: "test",
		penalty: 0,
	} as ClassificationProposal
}

/** Assert no two spans in the result overlap. */
function noOverlaps(out: readonly ClassificationProposal[]): boolean {
	for (let i = 0; i < out.length; i++) {
		for (let j = i + 1; j < out.length; j++) {
			if (out[i]!.span.start < out[j]!.span.end && out[j]!.span.start < out[i]!.span.end) return false
		}
	}

	return true
}

describe("resolveProposalOverlaps — trivial cases", () => {
	test("empty → empty", () => {
		expect(resolveProposalOverlaps([])).toEqual([])
	})

	test("single proposal → unchanged", () => {
		const out = resolveProposalOverlaps([p("street", "Main St", 0, 0.9)])
		expect(out).toHaveLength(1)
	})

	test("non-overlapping (adjacent) spans are all kept, in span order", () => {
		// "350" [0,3], "5th Ave" [4,11] — a space at index 3, no overlap.
		const out = resolveProposalOverlaps([p("street", "5th Ave", 4, 0.9), p("house_number", "350", 0, 0.9)])
		expect(out.map((x) => x.component)).toEqual(["house_number", "street"])
		expect(noOverlaps(out)).toBe(true)
	})

	test("touching spans (end === next start) do not overlap — both kept", () => {
		const out = resolveProposalOverlaps([p("house_number", "350", 0, 0.9), p("street", "5thAve", 3, 0.9)])
		expect(out).toHaveLength(2)
		expect(noOverlaps(out)).toBe(true)
	})
})

describe("resolveProposalOverlaps — overlap resolution", () => {
	test("containment: higher-confidence span wins, the other is dropped", () => {
		const out = resolveProposalOverlaps([
			p("street", "350 5th Ave", 0, 0.8), // coarse, lower conf
			p("house_number", "350", 0, 0.9), // finer, higher conf
		])
		expect(out).toHaveLength(1)
		expect(out[0]!.component).toBe("house_number")
		expect(noOverlaps(out)).toBe(true)
	})

	test("PRECONDITION: equal-confidence decomposition beats the coarse subsuming span", () => {
		// street[0,11] vs {house_number[0,3], street[4,11]} all at conf 0.9.
		// Finer-span-first tiebreak accepts the two small spans; the coarse [0,11] overlaps both → dropped.
		const out = resolveProposalOverlaps([
			p("street", "350 5th Ave", 0, 0.9),
			p("house_number", "350", 0, 0.9),
			p("street", "5th Ave", 4, 0.9),
		])
		expect(out.map((x) => `${x.component}[${x.span.start},${x.span.end}]`)).toEqual([
			"house_number[0,3]",
			"street[4,11]",
		])
		expect(noOverlaps(out)).toBe(true)
	})

	test("partial overlap: higher-confidence span wins", () => {
		const out = resolveProposalOverlaps([p("locality", "abcde", 0, 0.7), p("region", "defgh", 3, 0.9)])
		expect(out).toHaveLength(1)
		expect(out[0]!.component).toBe("region")
	})

	test("identical spans, different tags → higher-confidence tag kept", () => {
		const out = resolveProposalOverlaps([p("locality", "Springfield", 0, 0.8), p("region", "Springfield", 0, 0.9)])
		expect(out).toHaveLength(1)
		expect(out[0]!.component).toBe("region")
	})

	test("confidence is primary: a confident coarse span evicts finer low-confidence spans", () => {
		// Documents the policy tradeoff — a high-confidence subsuming span wins over a finer decomposition.
		const out = resolveProposalOverlaps([
			p("street", "350 5th Ave", 0, 0.95),
			p("house_number", "350", 0, 0.7),
			p("street", "5th Ave", 4, 0.7),
		])
		expect(out).toHaveLength(1)
		expect(out[0]!.span.start).toBe(0)
		expect(out[0]!.span.end).toBe(11)
	})
})

describe("resolveProposalOverlaps — coherence invariant", () => {
	test("a fully-tiling address is preserved intact", () => {
		const out = resolveProposalOverlaps([
			p("house_number", "350", 0, 0.9),
			p("street", "5th Ave", 4, 0.9),
			p("locality", "New York", 12, 0.9),
			p("region", "NY", 21, 0.9),
		])
		expect(out).toHaveLength(4)
		expect(noOverlaps(out)).toBe(true)
		expect(out.map((x) => x.span.start)).toEqual([0, 4, 12, 21]) // span-start order
	})

	test("output never overlaps even from a messy multi-source pile", () => {
		const out = resolveProposalOverlaps([
			p("street", "350 5th Ave", 0, 0.6),
			p("house_number", "350", 0, 0.95),
			p("street", "5th Ave", 4, 0.9),
			p("street", "5th", 4, 0.5),
			p("locality", "5th Ave New", 4, 0.4),
		])
		expect(noOverlaps(out)).toBe(true)
	})
})
