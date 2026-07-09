/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Contract tests for the Stage 2.7 span proposer (M2 + M3). Essential properties: unbalanced
 *   delimiters NEVER propose; annotation confidence follows content shape (trailing-country groups
 *   stay below consumer floors); dual-path numeric readings emit BOTH alternatives under one group;
 *   designator proposals are codex-conditioned and suppressed inside confident annotations.
 */

import { describe, expect, it } from "vitest"

import { EMPTY_SPAN_PROPOSER_LEXICON, proposeSpans, type SpanProposerLexicon } from "./span-proposer.ts"

/** Codex-shaped fixture lexicon (the real one is built from @mailwoman/codex in neural). */
const LEXICON: SpanProposerLexicon = {
	systems: new Set(["us", "au", "nz"]),
	unitDesignators: new Set(["apt", "apartment", "suite", "ste", "unit", "rm", "room", "bldg", "building"]),
	levelDesignators: new Set(["fl", "floor", "bsmt", "basement"]),
	weakDesignators: new Set(["bldg", "building"]),
	deliveryService: /\b(?:p\.?\s*o\.?\s*box|gpo\s+box|private\s+bag|locked\s+bag)\s*#?\s*(\d[\dA-Za-z-]*)\b/gi,
}

const usOnly: SpanProposerLexicon = { ...LEXICON, systems: new Set(["us"]) }

describe("paired delimiters (M2)", () => {
	it("proposes ANNOTATION_SPAN for balanced parens with aside-shaped content", () => {
		const text = "42 Wallaby Way (rear entrance), Sydney NSW 2000"
		const spans = proposeSpans(text, EMPTY_SPAN_PROPOSER_LEXICON)
		const ann = spans.filter((s) => s.kind === "ANNOTATION_SPAN")
		expect(ann).toHaveLength(1)
		expect(text.slice(ann[0]!.start, ann[0]!.end)).toBe("(rear entrance)")
		expect(ann[0]!.confidence).toBeGreaterThanOrEqual(0.9)
	})

	it("scores a trailing short capitalized group BELOW the consumer floor (paren-component shape)", () => {
		const spans = proposeSpans("42 Wallaby Way, Sydney, NSW 2000 (Australia)", EMPTY_SPAN_PROPOSER_LEXICON)
		const ann = spans.find((s) => s.kind === "ANNOTATION_SPAN")
		expect(ann).toBeDefined()
		expect(ann!.confidence).toBeLessThan(0.6)
	})

	it("emits NO proposal for unbalanced delimiters — never guess the missing pair", () => {
		expect(proposeSpans("Joe's \"Pizza, 12 Main St", EMPTY_SPAN_PROPOSER_LEXICON)).toHaveLength(0)
		expect(proposeSpans("12 Main St (rear entrance, Springfield", EMPTY_SPAN_PROPOSER_LEXICON)).toHaveLength(0)
		expect(proposeSpans("12 Main St ]oops[ Springfield", EMPTY_SPAN_PROPOSER_LEXICON)).toHaveLength(0)
	})

	it("proposes QUOTED_SPAN for balanced double quotes", () => {
		const text = '"Big Company HQ", 100 Business Ave, Los Angeles, CA 90001'
		const spans = proposeSpans(text, EMPTY_SPAN_PROPOSER_LEXICON)
		const q = spans.filter((s) => s.kind === "QUOTED_SPAN")
		expect(q).toHaveLength(1)
		expect(text.slice(q[0]!.start, q[0]!.end)).toBe('"Big Company HQ"')
	})

	it("keeps a bracketed strong designator+id OUT of the annotation read ([Suite 9] is a unit)", () => {
		const text = "212 Stuart St [Suite 9], Boston, MA 02116"
		const spans = proposeSpans(text, LEXICON)
		const ann = spans.find((s) => s.kind === "ANNOTATION_SPAN")
		expect(ann!.confidence).toBeLessThan(0.6)
		const unit = spans.find((s) => s.kind === "UNIT_PHRASE")
		expect(unit).toBeDefined()
		expect(text.slice(unit!.start, unit!.end)).toBe("Suite 9")
	})

	it("treats a bracketed WEAK designator as annotation ([Building A] describes)", () => {
		const text = "100 Business Ave [Building A], Suite 500, Los Angeles, CA 90001"
		const spans = proposeSpans(text, LEXICON)
		const ann = spans.find((s) => s.kind === "ANNOTATION_SPAN")
		expect(ann!.confidence).toBeGreaterThanOrEqual(0.6)
		// The "Building A" unit proposal is suppressed inside the confident annotation…
		const units = spans.filter((s) => s.kind === "UNIT_PHRASE")
		// …but the real "Suite 500" outside it survives.
		expect(units).toHaveLength(1)
		expect(text.slice(units[0]!.start, units[0]!.end)).toBe("Suite 500")
	})

	it("suppresses designator phrases inside a confident annotation ((Apt 4 around back))", () => {
		const text = "123 Main St (Apt 4 around back) Springfield IL 62701"
		const spans = proposeSpans(text, LEXICON)
		expect(spans.filter((s) => s.kind === "UNIT_PHRASE")).toHaveLength(0)
		expect(spans.find((s) => s.kind === "ANNOTATION_SPAN")!.confidence).toBeGreaterThanOrEqual(0.6)
	})

	it("does NOT suppress designator phrases inside quotes (quotes wrap names)", () => {
		const text = '123 Main St, "Apartment 4B", New York, NY 10001'
		const spans = proposeSpans(text, LEXICON)
		const unit = spans.find((s) => s.kind === "UNIT_PHRASE")
		expect(unit).toBeDefined()
		expect(text.slice(unit!.start, unit!.end)).toBe("Apartment 4B")
	})
})

describe("designator + identifier", () => {
	it("proposes UNIT_PHRASE and PO_BOX_PHRASE from the lexicon tables", () => {
		const text = "PO Box 19, Apt 4B, Springfield"
		const spans = proposeSpans(text, LEXICON)
		const po = spans.find((s) => s.kind === "PO_BOX_PHRASE")
		expect(text.slice(po!.start, po!.end)).toBe("PO Box 19")
		const unit = spans.find((s) => s.kind === "UNIT_PHRASE")
		expect(text.slice(unit!.start, unit!.end)).toBe("Apt 4B")
	})

	it("proposes LEVEL_PHRASE for level-class designators", () => {
		const text = "Floor 3, 100 Main St"
		const spans = proposeSpans(text, LEXICON)
		const level = spans.find((s) => s.kind === "LEVEL_PHRASE")
		expect(text.slice(level!.start, level!.end)).toBe("Floor 3")
	})

	it("emits nothing without a lexicon (codex-conditioned)", () => {
		expect(proposeSpans("PO Box 19, Apt 4B", EMPTY_SPAN_PROPOSER_LEXICON)).toHaveLength(0)
	})
})

describe("dual-path numeric readings (M3)", () => {
	it("emits BOTH readings for a designator-led slash compound (Unit 4/22)", () => {
		const text = "Unit 4/22 Smith St, Melbourne VIC 3000"
		const spans = proposeSpans(text, LEXICON)
		const unit = spans.find((s) => s.kind === "SPLIT_UNIT")!
		const hn = spans.find((s) => s.kind === "SPLIT_HOUSE_NUMBER")!
		const fused = spans.find((s) => s.kind === "FUSED_NUMBER")!
		expect(text.slice(unit.start, unit.end)).toBe("Unit 4")
		expect(text.slice(hn.start, hn.end)).toBe("22")
		expect(text.slice(fused.start, fused.end)).toBe("4/22")
		// All three are alternatives of one surface.
		expect(new Set([unit.alternativeGroup, hn.alternativeGroup, fused.alternativeGroup]).size).toBe(1)
		expect(unit.confidence).toBeGreaterThan(fused.confidence)
	})

	it("covers the AU leading-designator shape without vocabulary (Flat 2/14)", () => {
		const text = "Flat 2/14 Ponsonby Rd, Auckland 1011"
		const spans = proposeSpans(text, LEXICON)
		const unit = spans.find((s) => s.kind === "SPLIT_UNIT")!
		expect(text.slice(unit.start, unit.end)).toBe("Flat 2")
		const hn = spans.find((s) => s.kind === "SPLIT_HOUSE_NUMBER")!
		expect(text.slice(hn.start, hn.end)).toBe("14")
	})

	it("splits a bare leading compound only when AU/NZ tables are loaded (3/45 Wattle St)", () => {
		const text = "3/45 Wattle St, Ultimo NSW 2007"
		const auSpans = proposeSpans(text, LEXICON)
		expect(auSpans.some((s) => s.kind === "SPLIT_UNIT")).toBe(true)
		const usSpans = proposeSpans(text, usOnly)
		expect(usSpans.some((s) => s.kind === "SPLIT_UNIT")).toBe(false)
	})

	it("fuses the USPS half address (123 1/2) — no split reading", () => {
		const text = "123 1/2 Main St, Springfield, IL 62701"
		const spans = proposeSpans(text, LEXICON)
		const fused = spans.find((s) => s.kind === "FUSED_NUMBER")!
		expect(text.slice(fused.start, fused.end)).toBe("123 1/2")
		expect(spans.some((s) => s.kind === "SPLIT_UNIT")).toBe(false)
	})

	it("fuses the trailing European slash form (Hauptstraße 14/2) and skips short leaders (Hwy 50/89)", () => {
		const de = proposeSpans("Hauptstraße 14/2, 70173 Stuttgart", LEXICON)
		const fused = de.find((s) => s.kind === "FUSED_NUMBER")
		expect(fused).toBeDefined()
		expect(de.some((s) => s.kind === "SPLIT_UNIT")).toBe(false)
		// "Hwy" (3 chars) is below the trailing-fused guard; "50/89" is part of the street.
		const hwy = proposeSpans("Hwy 50/89 Junction, South Lake Tahoe, CA 96150", LEXICON)
		expect(hwy.filter((s) => s.kind !== "ANNOTATION_SPAN" && s.kind !== "QUOTED_SPAN")).toHaveLength(0)
	})

	it("never proposes a reading for the ZIP+4 hyphen shape", () => {
		const spans = proposeSpans("100 Main St, Springfield, IL 62701-1234", LEXICON)
		expect(spans.filter((s) => s.kind === "FUSED_NUMBER")).toHaveLength(0)
	})

	it("fuses a hyphen compound in house-number position (69-10 47th Ave)", () => {
		const text = "69-10 47th Ave, Queens, NY 11377"
		const spans = proposeSpans(text, LEXICON)
		const fused = spans.find((s) => s.kind === "FUSED_NUMBER")!
		expect(text.slice(fused.start, fused.end)).toBe("69-10")
	})
})

describe("degenerate inputs", () => {
	it("returns [] on empty input", () => {
		expect(proposeSpans("", LEXICON)).toEqual([])
	})

	it("returns proposals sorted by start", () => {
		const spans = proposeSpans("PO Box 19 (rear), Apt 4B", LEXICON)
		const starts = spans.map((s) => s.start)
		expect(starts).toEqual([...starts].sort((a, b) => a - b))
	})
})
