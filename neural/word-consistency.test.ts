/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { enforceWordConsistency } from "./word-consistency.ts"

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

describe("enforceWordConsistency only arbitrates DISAGREEING words (the documented contract)", () => {
	it("never rewrites an already-consistent multi-piece word, even when the vote mass prefers another type", () => {
		// `▁G am le` all street (B,I,I — consistent), but the summed emissions lean locality. The heal's
		// job is consistency, not re-decoding: viterbi's global choice stands. (The `Gamle Drammensvei`
		// golden regression, 2026-07-15.)
		const pieces = [{ piece: "▁G" }, { piece: "am" }, { piece: "le" }]
		const emissions = [peak(1, 8), peak(1, 8), peak(3, 2)] // locality-heavy mass
		const r = enforceWordConsistency(pieces, emissions, LABELS, [3, 4, 4]) // B-region I-region I-region (consistent)
		expect(r.healedWords).toBe(0)
		expect(r.labelIndices).toEqual([3, 4, 4])
	})

	it("never flips a single-piece word (no intra-word inconsistency exists)", () => {
		// `▁Broadway` B-street via viterbi; local mass prefers O. A one-piece word is trivially
		// consistent — the heal must not override the decoder. (The `East Broadway` golden regression.)
		const r = enforceWordConsistency([{ piece: "▁Broadway" }], [peak(0, 8)], LABELS, [1])
		expect(r.healedWords).toBe(0)
		expect(r.labelIndices).toEqual([1])
	})
})

describe("enforceWordConsistency confidence gates (#727 gated variant)", () => {
	it("minMeanConfidence skips a low-confidence heal (noise-amplification guard)", () => {
		// Near-flat emissions: the vote has no conviction. Ungated it still heals; gated it must not.
		const flat = (idx: number): number[] => LABELS.map((_l, i) => (i === idx ? 0.1 : 0))
		const pieces = [{ piece: "▁VER" }, { piece: "MONT" }]
		const ungated = enforceWordConsistency(pieces, [flat(1), flat(3)], LABELS, [1, 3])
		expect(ungated.healedWords).toBe(1)
		const gated = enforceWordConsistency(pieces, [flat(1), flat(3)], LABELS, [1, 3], { minMeanConfidence: 0.5 })
		expect(gated.healedWords).toBe(0)
		expect(gated.labelIndices).toEqual([1, 3]) // untouched
	})

	it("minMeanConfidence still heals a high-confidence disagreement", () => {
		const r = enforceWordConsistency([{ piece: "▁Loz" }, { piece: "ère" }], [peak(1, 3), peak(3, 9)], LABELS, [1, 3], {
			minMeanConfidence: 0.5,
		})
		expect(r.healedWords).toBe(1)
		expect([LABELS[r.labelIndices[0]!], LABELS[r.labelIndices[1]!]]).toEqual(["B-region", "I-region"])
	})

	it("skipByteFallbackWords leaves a word with a raw byte piece untouched", () => {
		// RO `ț` byte-falls-back: `<0xC8> <0x9B>` pieces inside the word. The vote premise breaks → skip.
		const pieces = [{ piece: "▁Gala" }, { piece: "<0xC8>" }, { piece: "<0x9B>" }, { piece: "i" }]
		const emissions = [peak(1, 8), peak(3, 8), peak(3, 8), peak(1, 8)]
		const r = enforceWordConsistency(pieces, emissions, LABELS, [1, 3, 3, 1], { skipByteFallbackWords: true })
		expect(r.healedWords).toBe(0)
		expect(r.labelIndices).toEqual([1, 3, 3, 1])
	})

	it("splitOnPunctuation lets the halves of a slash compound keep different tags", () => {
		// `12/345` = one SentencePiece word, two components (unit 12 / house number 345). With the slash
		// as a separator each half votes alone → already-consistent halves stay byte-identical.
		const pieces = [{ piece: "▁1" }, { piece: "2" }, { piece: "/" }, { piece: "3" }, { piece: "45" }]
		const emissions = [peak(1, 8), peak(1, 8), peak(0, 8), peak(3, 8), peak(3, 8)]
		const labelIndices = [1, 2, 0, 3, 4] // B-loc I-loc O B-reg I-reg (stand-ins for unit/house_number)
		const ungated = enforceWordConsistency(pieces, emissions, LABELS, labelIndices)
		expect(ungated.healedWords).toBe(1) // the flattening the gate exists to prevent
		const gated = enforceWordConsistency(pieces, emissions, LABELS, labelIndices, { splitOnPunctuation: true })
		expect(gated.healedWords).toBe(0)
		expect(gated.labelIndices).toEqual(labelIndices)
	})

	it("splitOnPunctuation keeps a trailing comma piece out of the preceding word's vote", () => {
		// After a bare `▁` separator, `Ave` arrives with no sentinel and the following `,` would join
		// its group as a continuation — its O label manufactures a fake disagreement and the vote kills
		// the suffix (`1st Ave,` → Ave:O, the 2026-07-15 golden class). As a separator the comma leaves
		// `Ave` a trivially-consistent single-piece word → untouched.
		const pieces = [{ piece: "Ave" }, { piece: "," }]
		const emissions = [peak(1, 1), peak(0, 9)] // weak street mass on Ave, huge O mass on the comma
		const ungated = enforceWordConsistency(pieces, emissions, LABELS, [1, 0])
		expect(ungated.healedWords).toBe(1) // comma's O mass drags Ave to O
		const gated = enforceWordConsistency(pieces, emissions, LABELS, [1, 0], { splitOnPunctuation: true })
		expect(gated.healedWords).toBe(0)
		expect(gated.labelIndices).toEqual([1, 0])
	})
})
