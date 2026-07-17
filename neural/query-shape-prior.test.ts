/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { addEmissionMatrix, buildEmissionPriors, type QueryShapeLike } from "./query-shape-prior.ts"

const LABELS = ["O", "B-locality", "I-locality", "B-postcode", "I-postcode", "B-po_box", "I-po_box"]

function emptyShape(): QueryShapeLike {
	return { knownFormats: [] }
}

function tokens(...spans: Array<[number, number]>): Array<{ start: number; end: number }> {
	return spans.map(([s, e]) => ({ start: s, end: e }))
}

describe("buildEmissionPriors", () => {
	it("returns all-zero matrix for empty knownFormats", () => {
		const m = buildEmissionPriors(emptyShape(), tokens([0, 5], [6, 10]), LABELS)
		expect(m).toHaveLength(2)
		expect(m[0]?.every((x) => x === 0)).toBe(true)
		expect(m[1]?.every((x) => x === 0)).toBe(true)
	})

	it("boosts B-postcode for us_zip hits on overlapping tokens", () => {
		const shape: QueryShapeLike = {
			knownFormats: [{ format: "us_zip", span: { start: 27, end: 32 }, confidence: 0.6 }],
		}
		// Three tokens; only the last overlaps the postcode span.
		const toks = tokens([0, 3], [4, 7], [27, 32])
		const m = buildEmissionPriors(shape, toks, LABELS)
		const postcodeCol = LABELS.indexOf("B-postcode")
		expect(m[0]?.[postcodeCol]).toBe(0)
		expect(m[1]?.[postcodeCol]).toBe(0)
		expect(m[2]?.[postcodeCol]).toBeCloseTo(0.6, 6)
	})

	it("scales bias by biasScale", () => {
		const shape: QueryShapeLike = {
			knownFormats: [{ format: "us_zip", span: { start: 0, end: 5 }, confidence: 0.6 }],
		}
		const m = buildEmissionPriors(shape, tokens([0, 5]), LABELS, { biasScale: 2 })
		const postcodeCol = LABELS.indexOf("B-postcode")
		expect(m[0]?.[postcodeCol]).toBeCloseTo(1.2, 6)
	})

	it("handles multi-token overlap (us_zip4 spans two tokens via hyphen)", () => {
		// In practice tokenizers may split "10118-1234" into ["10118", "-", "1234"]; verify all three
		// get the postcode bias when the hit span covers all of them.
		const shape: QueryShapeLike = {
			knownFormats: [{ format: "us_zip4", span: { start: 0, end: 10 }, confidence: 0.95 }],
		}
		const toks = tokens([0, 5], [5, 6], [6, 10])
		const m = buildEmissionPriors(shape, toks, LABELS)
		const postcodeCol = LABELS.indexOf("B-postcode")

		for (let t = 0; t < toks.length; t++) {
			expect(m[t]?.[postcodeCol]).toBeCloseTo(0.95, 6)
		}
	})

	it("takes the MAX bias when multiple format hits overlap the same token", () => {
		const shape: QueryShapeLike = {
			knownFormats: [
				{ format: "us_zip", span: { start: 0, end: 5 }, confidence: 0.6 },
				{ format: "fr_postcode", span: { start: 0, end: 5 }, confidence: 0.6 },
				{ format: "de_postcode", span: { start: 0, end: 5 }, confidence: 0.6 },
			],
		}
		const m = buildEmissionPriors(shape, tokens([0, 5]), LABELS)
		const postcodeCol = LABELS.indexOf("B-postcode")
		// All three hits map to B-postcode; bias is the max (not sum) → 0.6, not 1.8
		expect(m[0]?.[postcodeCol]).toBeCloseTo(0.6, 6)
	})

	it("maps po_box → B-po_box", () => {
		const shape: QueryShapeLike = {
			knownFormats: [{ format: "po_box", span: { start: 0, end: 12 }, confidence: 0.85 }],
		}
		const m = buildEmissionPriors(shape, tokens([0, 2], [3, 6], [7, 12]), LABELS)
		const poBoxCol = LABELS.indexOf("B-po_box")
		expect(m[0]?.[poBoxCol]).toBeCloseTo(0.85, 6)
		expect(m[1]?.[poBoxCol]).toBeCloseTo(0.85, 6)
		expect(m[2]?.[poBoxCol]).toBeCloseTo(0.85, 6)
	})

	it("ignores unknown format names", () => {
		const shape: QueryShapeLike = {
			knownFormats: [{ format: "made_up_format", span: { start: 0, end: 5 }, confidence: 0.9 }],
		}
		const m = buildEmissionPriors(shape, tokens([0, 5]), LABELS)
		expect(m[0]?.every((x) => x === 0)).toBe(true)
	})

	it("ignores hits whose target label is absent from the vocabulary", () => {
		// Drop B-postcode from the vocab — bias has no column to land in.
		const slim = ["O", "B-locality", "I-locality"]
		const shape: QueryShapeLike = {
			knownFormats: [{ format: "us_zip", span: { start: 0, end: 5 }, confidence: 0.6 }],
		}
		const m = buildEmissionPriors(shape, tokens([0, 5]), slim)
		expect(m[0]?.every((x) => x === 0)).toBe(true)
	})

	it("does not bias non-overlapping tokens", () => {
		const shape: QueryShapeLike = {
			knownFormats: [{ format: "us_zip", span: { start: 100, end: 105 }, confidence: 0.6 }],
		}
		const m = buildEmissionPriors(shape, tokens([0, 5], [6, 10]), LABELS)
		expect(m[0]?.every((x) => x === 0)).toBe(true)
		expect(m[1]?.every((x) => x === 0)).toBe(true)
	})
})

describe("buildEmissionPriors — SCOPED locality bias (2026-07-17 rebuild)", () => {
	// The original backward-walk locality bias was retired after the M1 stack ablation attributed the
	// prior's entire −7.8pp golden-us locality cost to it (venue/org absorption: "DANVILLE HEALTH
	// CENTER, 26 Cedar Lane, Danville VT" → locality "danville health center"). The gauntlet regression
	// layer then caught the over-correction: bare "New York, NY" (us-new-york-nyc) NEEDS the bias — the
	// model alone drops the locality. This scoped rebuild fires ONLY on that bare admin doubleton:
	// no digits, abbreviation last, ≤4 preceding tokens, name ≠ the region's own name.
	const bLoc = LABELS.indexOf("B-locality")
	const iLoc = LABELS.indexOf("I-locality")

	it("fires on the bare doubleton — New York, NY", () => {
		const shape = { knownFormats: [], regionAbbreviations: [{ start: 10, span: "NY" }] } as QueryShapeLike
		const m = buildEmissionPriors(shape, tokens([0, 3], [4, 8], [10, 12]), LABELS, { inputText: "New York, NY" })

		expect(m[0]![bLoc]).toBeGreaterThan(0)
		expect(m[1]![iLoc]).toBeGreaterThan(0)
		expect(m[2]![bLoc]).toBe(0)
	})

	it("does NOT fire when the input carries digits (the M1 venue/street failure class)", () => {
		const text = "Danville Health Center, 26 Cedar Lane, Danville VT"
		const shape = { knownFormats: [], regionAbbreviations: [{ start: 48, span: "VT" }] } as QueryShapeLike
		const toks = tokens([0, 8], [9, 15], [16, 22], [24, 26], [27, 32], [33, 37], [39, 47], [48, 50])
		const m = buildEmissionPriors(shape, toks, LABELS, { inputText: text })

		for (const row of m) {
			expect(row[bLoc]).toBe(0)
			expect(row[iLoc]).toBe(0)
		}
	})

	it("does NOT fire when more than 4 tokens precede the abbreviation", () => {
		const text = "Community Health Service Inc Grafton ND"
		const shape = { knownFormats: [], regionAbbreviations: [{ start: 37, span: "ND" }] } as QueryShapeLike
		const toks = tokens([0, 9], [10, 16], [17, 24], [25, 28], [29, 36], [37, 39])
		const m = buildEmissionPriors(shape, toks, LABELS, { inputText: text })

		for (const row of m) {
			expect(row[bLoc]).toBe(0)
		}
	})

	it("does NOT fire when a token follows the abbreviation (not the doubleton shape)", () => {
		const text = "New York, NY tomorrow"
		const shape = { knownFormats: [], regionAbbreviations: [{ start: 10, span: "NY" }] } as QueryShapeLike
		const m = buildEmissionPriors(shape, tokens([0, 3], [4, 8], [10, 12], [13, 21]), LABELS, { inputText: text })

		for (const row of m) {
			expect(row[bLoc]).toBe(0)
		}
	})

	it("fires for Washington, DC and — deliberately — for Washington, WA (the old name-IS-region guard was dead in production)", () => {
		// The retired version compared the preceding text against the region's full name, but production
		// passes PIECE spans that include the trailing comma, so the comparison never matched. The bias is
		// soft (+2.0 log-odds): a confident region emission on a true state-restatement still wins.
		for (const [text, span] of [
			["Washington, DC", "DC"],
			["Washington, WA", "WA"],
		] as const) {
			const shape = { knownFormats: [], regionAbbreviations: [{ start: 12, span }] } as QueryShapeLike
			const m = buildEmissionPriors(shape, tokens([0, 10], [12, 14]), LABELS, { inputText: text })

			expect(m[0]![bLoc]).toBeGreaterThan(0)
		}
	})

	it("never fires without inputText (the digit guard cannot run)", () => {
		const shape = { knownFormats: [], regionAbbreviations: [{ start: 10, span: "NY" }] } as QueryShapeLike
		const m = buildEmissionPriors(shape, tokens([0, 3], [4, 8], [10, 12]), LABELS)

		for (const row of m) {
			expect(row[bLoc]).toBe(0)
		}
	})
})

describe("addEmissionMatrix", () => {
	it("returns emissions unchanged when priors are empty", () => {
		const e = [
			[1, 2, 3],
			[4, 5, 6],
		]
		const result = addEmissionMatrix(e, [])
		expect(result).toEqual(e)
		expect(result).not.toBe(e) // new array
	})

	it("adds element-wise when shapes match", () => {
		const e = [
			[1, 2],
			[3, 4],
		]
		const p = [
			[0.5, 0.5],
			[1, 1],
		]
		expect(addEmissionMatrix(e, p)).toEqual([
			[1.5, 2.5],
			[4, 5],
		])
	})

	it("treats missing prior rows as zeros (defensive)", () => {
		const e = [
			[1, 2],
			[3, 4],
		]
		const p = [[0.5, 0.5]]
		expect(addEmissionMatrix(e, p)).toEqual([
			[1.5, 2.5],
			[3, 4],
		])
	})
})
