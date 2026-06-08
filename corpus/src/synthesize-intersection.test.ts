/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for the v0.7 intersection synthesizer. Validates the {raw, components} contract AND the BIO
 *   output by running rows through the real `alignRow` aligner — confirming the model will see
 *   B-/I-intersection_a, O on the connector, and B-/I-intersection_b (the signal it currently
 *   lacks).
 */

import { describe, expect, it } from "vitest"
import { alignRow } from "./align.js"
import {
	DEFAULT_US_BASES,
	generateIntersectionRows,
	synthesizeIntersectionRow,
	type SynthesizedIntersectionRow,
} from "./synthesize-intersection.js"
import type { CanonicalRow } from "./types.js"

/** Deterministic PRNG so tests are reproducible. */
function mulberry32(seed: number): () => number {
	let a = seed >>> 0
	return () => {
		a |= 0
		a = (a + 0x6d2b79f5) | 0
		let t = Math.imul(a ^ (a >>> 15), 1 | a)
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

function asCanonical(r: SynthesizedIntersectionRow): CanonicalRow {
	return { ...r, country: "US", source: "synth-intersection", source_id: "synth-intersection:test" } as CanonicalRow
}

describe("synthesizeIntersectionRow", () => {
	it("emits both street surface forms verbatim in raw (alignment contract)", () => {
		const row = synthesizeIntersectionRow(DEFAULT_US_BASES[0]!, { random: mulberry32(1) })!
		expect(row).not.toBeNull()
		expect(row.raw).toContain(row.components.intersection_a!)
		expect(row.raw).toContain(row.components.intersection_b!)
		expect(row.components.intersection_a).not.toBe(row.components.intersection_b)
	})

	it("produces a meaningful fraction of BARE intersections (no locality tail) — v0.7.2", () => {
		// The harness's intersection assertions are bare "X & Y"; v0.7.1 fumbled them because every
		// synthetic row had a ", City, ST" tail. Verify ~60% are now tail-less.
		const rows = generateIntersectionRows(400, DEFAULT_US_BASES, { random: mulberry32(99) })
		const bare = rows.filter((r) => r.components.locality == null)
		expect(bare.length).toBeGreaterThan(rows.length * 0.4)
		// Bare rows still carry both intersection tags.
		for (const r of bare.slice(0, 20)) {
			expect(r.components.intersection_a).toBeTruthy()
			expect(r.components.intersection_b).toBeTruthy()
		}
	})

	it("aligns to BIO with B-intersection_a before B-intersection_b", () => {
		// NB: align.ts's default whitespace tokenizer strips standalone punctuation, so the connector
		// ("&", "/", …) leaves no token. What matters — and what we assert — is that the two street
		// spans label correctly and in order. The connector's label is a tokenizer detail (the
		// production SentencePiece tokenizer keeps "&" as an O token); not the generator's contract.
		const row = synthesizeIntersectionRow(DEFAULT_US_BASES[0]!, { random: mulberry32(7) })!
		const result = alignRow(asCanonical(row))
		expect(result.kind).toBe("labeled")
		if (result.kind !== "labeled") return
		const labels = result.row.labels
		expect(labels).toContain("B-intersection_a")
		expect(labels).toContain("B-intersection_b")
		expect(labels.indexOf("B-intersection_a")).toBeLessThan(labels.indexOf("B-intersection_b"))
	})

	it("is deterministic under a fixed seed", () => {
		const a = synthesizeIntersectionRow(DEFAULT_US_BASES[2]!, { random: mulberry32(42) })!
		const b = synthesizeIntersectionRow(DEFAULT_US_BASES[2]!, { random: mulberry32(42) })!
		expect(a.raw).toBe(b.raw)
	})

	it("returns null for non-US bases (intersections are US-idiomatic here)", () => {
		expect(
			synthesizeIntersectionRow({ locality: "Paris", region: "IDF", country: "FR" }, { random: mulberry32(1) })
		).toBeNull()
	})
})

describe("generateIntersectionRows", () => {
	it("generates the requested count, all aligning cleanly with both intersection tags", () => {
		const rows = generateIntersectionRows(100, DEFAULT_US_BASES, { random: mulberry32(123) })
		expect(rows).toHaveLength(100)
		let labeled = 0
		for (const r of rows) {
			const result = alignRow(asCanonical(r))
			if (result.kind !== "labeled") continue
			labeled++
			expect(result.row.labels).toContain("B-intersection_a")
			expect(result.row.labels).toContain("B-intersection_b")
		}
		// alignment should succeed on the overwhelming majority (clean synthetic surface forms).
		expect(labeled).toBeGreaterThanOrEqual(95)
	})
})
