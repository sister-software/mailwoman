/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { enforceWordConsistency } from "./word-consistency.js"

const LABELS = ["O", "B-locality", "I-locality", "B-region", "I-region"] as const
/** A logit row peaking at `idx` (softmaxes to high prob there). */
const peak = (idx: number, hi: number): number[] => LABELS.map((_l, i) => (i === idx ? hi : 0))

describe("enforceWordConsistency (#727 / admin-token fragmentation)", () => {
	it("heals a fragmented word to ONE type by confidence-weighted vote (not first-piece-wins)", () => {
		// `▁VER` leans locality (idx1, modest), `MONT` is near-certain region (idx3, strong). The vote
		// sums region mass > locality mass → the WHOLE word becomes region (the `VER`-bleed is fixed).
		const pieces = [{ piece: "▁VER" }, { piece: "MONT" }]
		const emissions = [peak(1, 2), peak(3, 8)]
		const r = enforceWordConsistency(pieces, emissions, LABELS, [1, 3]) // B-locality, B-region (fragmented)
		expect(r.healedWords).toBe(1)
		expect(LABELS[r.labelIndices[0]!]).toBe("B-region")
		expect(LABELS[r.labelIndices[1]!]).toBe("I-region")
		// confidence = mean p(region) across the word, in (0,1]
		expect(r.healedConfidence.get(0)).toBeGreaterThan(0)
		expect(r.healedConfidence.get(0)).toBeLessThanOrEqual(1)
		expect(r.healedConfidence.get(0)).toBe(r.healedConfidence.get(1)) // same mean for both pieces
	})

	it("leaves an already-consistent word byte-identical (no heal)", () => {
		const r = enforceWordConsistency([{ piece: "▁Paris" }], [peak(1, 8)], LABELS, [1])
		expect(r.healedWords).toBe(0)
		expect(r.labelIndices).toEqual([1])
		expect(r.healedConfidence.size).toBe(0)
	})

	it("does NOT merge across ▁ — 'Saint Paul' stays two words (cross-word merge is the decoder's job)", () => {
		const r = enforceWordConsistency(
			[{ piece: "▁Saint" }, { piece: "▁Paul" }],
			[peak(1, 8), peak(1, 8)],
			LABELS,
			[1, 1]
		)
		expect(r.healedWords).toBe(0) // two independent locality words, each already B-locality
		expect(r.labelIndices).toEqual([1, 1])
	})

	it("an O-dominant word stays O (no spurious span forced onto a non-component word)", () => {
		const r = enforceWordConsistency([{ piece: "▁and" }, { piece: "co" }], [peak(0, 8), peak(0, 8)], LABELS, [0, 0])
		expect(r.healedWords).toBe(0)
		expect(r.labelIndices).toEqual([0, 0])
	})

	it("forces a clean B-/I- pattern when a mid-word piece flips to a different B-", () => {
		// `▁Loz` locality, `ère` flips to B-region → the diacritic split. Region mass wins → both region.
		const r = enforceWordConsistency([{ piece: "▁Loz" }, { piece: "ère" }], [peak(1, 3), peak(3, 7)], LABELS, [1, 3])
		expect(r.healedWords).toBe(1)
		expect([LABELS[r.labelIndices[0]!], LABELS[r.labelIndices[1]!]]).toEqual(["B-region", "I-region"])
	})
})
