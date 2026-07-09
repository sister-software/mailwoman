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

describe("buildEmissionPriors — locality bias", () => {
	const FULL_LABELS = [
		"O",
		"B-country",
		"I-country",
		"B-region",
		"I-region",
		"B-locality",
		"I-locality",
		"B-postcode",
		"I-postcode",
	]

	it("biases preceding token toward B-locality when region abbreviation detected", () => {
		// "Washington, DC" — token "Washington" at [0,10], comma at [10,11], space, "DC" at [12,14]
		const shape: QueryShapeLike = {
			knownFormats: [],
			regionAbbreviations: [{ start: 12, span: "DC" }],
		}
		// Token for "Washington" ends at 10; abbreviation starts at 12 (gap = 2 for ", ")
		const toks = tokens([0, 10], [12, 14])
		const m = buildEmissionPriors(shape, toks, FULL_LABELS)
		const bLocCol = FULL_LABELS.indexOf("B-locality")
		expect(m[0]?.[bLocCol]).toBe(2.0)
		// The abbreviation token itself should NOT get locality bias
		expect(m[1]?.[bLocCol]).toBe(0)
	})

	it("biases multi-word locality with B- and I- correctly", () => {
		// "New York, NY" — "New" at [0,3], "York" at [4,8], "NY" at [10,12]
		const shape: QueryShapeLike = {
			knownFormats: [],
			regionAbbreviations: [{ start: 10, span: "NY" }],
		}
		const toks = tokens([0, 3], [4, 8], [10, 12])
		const m = buildEmissionPriors(shape, toks, FULL_LABELS)
		const bLocCol = FULL_LABELS.indexOf("B-locality")
		const iLocCol = FULL_LABELS.indexOf("I-locality")
		// "New" should get B-locality, "York" should get I-locality
		expect(m[0]?.[bLocCol]).toBe(2.0)
		expect(m[1]?.[iLocCol]).toBe(2.0)
		// Abbreviation token gets nothing
		expect(m[2]?.[bLocCol]).toBe(0)
	})

	it("does not bias when no region abbreviations present", () => {
		const shape: QueryShapeLike = {
			knownFormats: [],
			regionAbbreviations: [],
		}
		const m = buildEmissionPriors(shape, tokens([0, 5], [6, 10]), FULL_LABELS)
		const bLocCol = FULL_LABELS.indexOf("B-locality")
		expect(m[0]?.[bLocCol]).toBe(0)
		expect(m[1]?.[bLocCol]).toBe(0)
	})

	it("does not bias tokens that are too far from the abbreviation", () => {
		// Token at [0,5], abbreviation at [50,52] — gap of 45 chars
		const shape: QueryShapeLike = {
			knownFormats: [],
			regionAbbreviations: [{ start: 50, span: "DC" }],
		}
		const m = buildEmissionPriors(shape, tokens([0, 5], [50, 52]), FULL_LABELS)
		const bLocCol = FULL_LABELS.indexOf("B-locality")
		expect(m[0]?.[bLocCol]).toBe(0)
	})

	it("respects custom localityBiasScale", () => {
		const shape: QueryShapeLike = {
			knownFormats: [],
			regionAbbreviations: [{ start: 12, span: "DC" }],
		}
		const toks = tokens([0, 10], [12, 14])
		const m = buildEmissionPriors(shape, toks, FULL_LABELS, { localityBiasScale: 3.0 })
		const bLocCol = FULL_LABELS.indexOf("B-locality")
		expect(m[0]?.[bLocCol]).toBe(3.0)
	})

	it("does not bias when preceding text matches the region name (Washington, WA)", () => {
		// "Washington, WA" — "Washington" IS the region name for WA, should NOT get locality bias
		const shape: QueryShapeLike = {
			knownFormats: [],
			regionAbbreviations: [{ start: 12, span: "WA" }],
		}
		const toks = tokens([0, 10], [12, 14])
		const m = buildEmissionPriors(shape, toks, FULL_LABELS, { inputText: "Washington, WA" })
		const bLocCol = FULL_LABELS.indexOf("B-locality")
		expect(m[0]?.[bLocCol]).toBe(0)
	})

	it("still biases when text does NOT match region name (Washington, DC)", () => {
		// "Washington, DC" — DC's region name is "District of Columbia", NOT "Washington"
		const shape: QueryShapeLike = {
			knownFormats: [],
			regionAbbreviations: [{ start: 12, span: "DC" }],
		}
		const toks = tokens([0, 10], [12, 14])
		const m = buildEmissionPriors(shape, toks, FULL_LABELS, { inputText: "Washington, DC" })
		const bLocCol = FULL_LABELS.indexOf("B-locality")
		expect(m[0]?.[bLocCol]).toBe(2.0)
	})

	it("does not bias New York before NY (region name match)", () => {
		// "New York, NY" — "New York" IS the region name for NY
		const shape: QueryShapeLike = {
			knownFormats: [],
			regionAbbreviations: [{ start: 10, span: "NY" }],
		}
		const toks = tokens([0, 3], [4, 8], [10, 12])
		const m = buildEmissionPriors(shape, toks, FULL_LABELS, { inputText: "New York, NY" })
		const bLocCol = FULL_LABELS.indexOf("B-locality")
		const iLocCol = FULL_LABELS.indexOf("I-locality")
		expect(m[0]?.[bLocCol]).toBe(0)
		expect(m[1]?.[iLocCol]).toBe(0)
	})

	it("skips tokens overlapping a known postcode format", () => {
		// "10118, NY" — "10118" overlaps a postcode hit, should NOT get locality bias
		const shape: QueryShapeLike = {
			knownFormats: [{ format: "us_zip", span: { start: 0, end: 5 }, confidence: 0.6 }],
			regionAbbreviations: [{ start: 7, span: "NY" }],
		}
		const toks = tokens([0, 5], [7, 9])
		const m = buildEmissionPriors(shape, toks, FULL_LABELS)
		const bLocCol = FULL_LABELS.indexOf("B-locality")
		// Token 0 is a postcode — should NOT get locality bias
		expect(m[0]?.[bLocCol]).toBe(0)
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
