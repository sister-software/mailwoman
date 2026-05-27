/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Contract + per-rule unit tests for the rule-based grouper. The kryptonite-catalogue fixture test
 *   (operator's adversarial examples) lives in `kryptonite.test.ts`.
 */

import { describe, expect, it } from "vitest"
import { groupPhrases, groupPhrasesSync } from "./group.js"
import {
	scoreHyphenatedCompound,
	scoreLocalityPhrase,
	scoreNumeric,
	scorePostcode,
	scoreRegionAbbreviation,
	scoreStreetPhrase,
	scoreVenuePhrase,
	tokenizeSegment,
} from "./rules.js"
import type { NormalizedInputLite, PhraseGrouper, PhraseProposal, QueryShapeLike } from "./types.js"

function input(normalized: string): NormalizedInputLite {
	return { raw: normalized, normalized }
}

function shape(opts: Partial<QueryShapeLike> = {}): QueryShapeLike {
	return { knownFormats: [], ...opts }
}

function kinds(proposals: PhraseProposal[]): string[] {
	return proposals.map((p) => p.kindHypothesis)
}

function findKind(proposals: PhraseProposal[], kind: string, body?: string): PhraseProposal | undefined {
	return proposals.find((p) => p.kindHypothesis === kind && (body === undefined || p.span.body === body))
}

describe("phrase-grouper — contract", () => {
	it("groupPhrasesSync returns an array", () => {
		const out: PhraseProposal[] = groupPhrasesSync(input("anything"), shape())
		expect(Array.isArray(out)).toBe(true)
	})

	it("groupPhrases async wrapper resolves to an array", async () => {
		const out = await groupPhrases(input("anything"), shape())
		expect(Array.isArray(out)).toBe(true)
	})

	it("empty input returns empty list", () => {
		expect(groupPhrasesSync(input(""), shape())).toEqual([])
	})

	it("satisfies the PhraseGrouper structural type", () => {
		const grouper: PhraseGrouper = { group: groupPhrases }
		expect(typeof grouper.group).toBe("function")
	})

	it("results sorted by descending confidence then ascending span start", () => {
		const out = groupPhrasesSync(
			input("350 5th Ave"),
			shape({
				segments: [{ body: "350 5th Ave", index: 0, span: { start: 0, end: 11 } }],
			})
		)
		for (let i = 1; i < out.length; i++) {
			const prev = out[i - 1]!
			const cur = out[i]!
			if (prev.confidence !== cur.confidence) {
				expect(prev.confidence).toBeGreaterThanOrEqual(cur.confidence)
			} else {
				expect(cur.span.start).toBeGreaterThanOrEqual(prev.span.start)
			}
		}
	})
})

describe("tokenizeSegment", () => {
	it("preserves absolute offsets when segment starts mid-input", () => {
		const tokens = tokenizeSegment("New York", 10)
		expect(tokens.map((t) => [t.body, t.start, t.end])).toEqual([
			["New", 10, 13],
			["York", 14, 18],
		])
	})

	it("collapses runs of whitespace", () => {
		expect(tokenizeSegment("  a   b  ", 0).map((t) => t.body)).toEqual(["a", "b"])
	})

	it("returns empty list for whitespace-only input", () => {
		expect(tokenizeSegment("   ", 0)).toEqual([])
	})
})

describe("scoreNumeric", () => {
	it("emits NUMERIC for pure-digit tokens", () => {
		const out = scoreNumeric(tokenizeSegment("350 Main", 0), "350 Main")
		expect(out).toHaveLength(1)
		expect(out[0]!.span.body).toBe("350")
		expect(out[0]!.confidence).toBeGreaterThanOrEqual(0.9)
	})

	it("5+ digit numerics emit at lower confidence (POSTCODE ambiguity)", () => {
		const out = scoreNumeric(tokenizeSegment("10118", 0), "10118")
		expect(out).toHaveLength(1)
		expect(out[0]!.confidence).toBeLessThan(0.7)
	})

	it("non-digit tokens emit nothing", () => {
		expect(scoreNumeric(tokenizeSegment("Main Street", 0), "Main Street")).toEqual([])
	})
})

describe("scorePostcode", () => {
	it("lifts QueryShape postcode hits to POSTCODE proposals", () => {
		const out = scorePostcode(
			shape({
				knownFormats: [{ format: "us_zip", span: { start: 23, end: 28 }, confidence: 0.92 }],
			}),
			"350 5th Ave, New York, 10118"
		)
		expect(out).toHaveLength(1)
		expect(out[0]!.span.body).toBe("10118")
		expect(out[0]!.confidence).toBeCloseTo(0.92)
	})

	it("skips po_box format (not a postcode)", () => {
		const out = scorePostcode(
			shape({ knownFormats: [{ format: "po_box", span: { start: 0, end: 8 }, confidence: 0.9 }] }),
			"PO Box 1"
		)
		expect(out).toEqual([])
	})
})

describe("scoreRegionAbbreviation", () => {
	it("emits REGION_ABBREVIATION for 2-letter caps at tail of segment with high confidence", () => {
		const out = scoreRegionAbbreviation(tokenizeSegment("New York NY", 0), "New York NY", true)
		const ny = findKind(out, "REGION_ABBREVIATION", "NY")
		expect(ny).toBeDefined()
		expect(ny!.confidence).toBeGreaterThanOrEqual(0.8)
	})

	it("non-tail position scores lower", () => {
		const out = scoreRegionAbbreviation(tokenizeSegment("NY foo", 0), "NY foo", true)
		const ny = findKind(out, "REGION_ABBREVIATION", "NY")
		expect(ny!.confidence).toBeLessThan(0.8)
	})

	it("3-letter caps also match (e.g. TWN)", () => {
		const out = scoreRegionAbbreviation(tokenizeSegment("Hsinchu TWN", 0), "Hsinchu TWN", true)
		expect(findKind(out, "REGION_ABBREVIATION", "TWN")).toBeDefined()
	})
})

describe("scoreHyphenatedCompound", () => {
	it("emits HYPHENATED_COMPOUND on internal-hyphen tokens", () => {
		const out = scoreHyphenatedCompound(tokenizeSegment("Saint-Denis", 0), "Saint-Denis")
		expect(out).toHaveLength(1)
		expect(out[0]!.span.body).toBe("Saint-Denis")
	})

	it("ignores leading/trailing-hyphen-only tokens", () => {
		expect(scoreHyphenatedCompound(tokenizeSegment("- foo -", 0), "- foo -")).toEqual([])
	})

	it("catches the NY-NY case", () => {
		const out = scoreHyphenatedCompound(tokenizeSegment("NY-NY Steakhouse", 0), "NY-NY Steakhouse")
		expect(findKind(out, "HYPHENATED_COMPOUND", "NY-NY")).toBeDefined()
	})
})

describe("scoreStreetPhrase", () => {
	it("emits STREET_PHRASE spanning house number + name + suffix", () => {
		const out = scoreStreetPhrase(tokenizeSegment("350 5th Ave", 0), "350 5th Ave")
		expect(out).toHaveLength(1)
		expect(out[0]!.span.body).toBe("350 5th Ave")
		expect(out[0]!.confidence).toBeGreaterThanOrEqual(0.85)
	})

	it("emits STREET_PHRASE without leading numeric at lower confidence", () => {
		const out = scoreStreetPhrase(tokenizeSegment("Main Street", 0), "Main Street")
		expect(out).toHaveLength(1)
		expect(out[0]!.confidence).toBeLessThan(0.9)
	})

	it("suffix alone with no preceding token emits nothing", () => {
		expect(scoreStreetPhrase(tokenizeSegment("Street", 0), "Street")).toEqual([])
	})
})

describe("scoreLocalityPhrase", () => {
	it("emits multiple proposals for Saint Petersburg (both lengths)", () => {
		const out = scoreLocalityPhrase(tokenizeSegment("Saint Petersburg", 0), "Saint Petersburg", true)
		const bodies = out.map((p) => p.span.body)
		expect(bodies).toContain("Saint Petersburg")
		expect(bodies).toContain("Saint")
	})

	it("tail-of-last-segment scores higher than mid-segment", () => {
		const tail = scoreLocalityPhrase(tokenizeSegment("Foo York", 0), "Foo York", true)
		const yorkAtTail = findKind(tail, "LOCALITY_PHRASE", "York")
		const mid = scoreLocalityPhrase(tokenizeSegment("York Foo", 0), "York Foo", true)
		const yorkAtHead = findKind(mid, "LOCALITY_PHRASE", "York")
		expect(yorkAtTail!.confidence).toBeGreaterThan(yorkAtHead!.confidence)
	})

	it("skips region abbreviations (they're owned by REGION_ABBREVIATION)", () => {
		const out = scoreLocalityPhrase(tokenizeSegment("NY foo", 0), "NY foo", true)
		expect(out.find((p) => p.span.body === "NY")).toBeUndefined()
	})

	it("penalizes single-word US state names in non-tail position", () => {
		const tokens = tokenizeSegment("Washington DC", 0)
		const out = scoreLocalityPhrase(tokens, "Washington DC", false)
		const washConf = out.find((p) => p.span.body === "Washington")?.confidence ?? 0
		const springTokens = tokenizeSegment("Springfield IL", 0)
		const springOut = scoreLocalityPhrase(springTokens, "Springfield IL", false)
		const springConf = springOut.find((p) => p.span.body === "Springfield")!.confidence
		expect(washConf).toBeLessThan(springConf)
	})

	it("still emits multi-word runs containing a state name (New York)", () => {
		const out = scoreLocalityPhrase(tokenizeSegment("New York", 0), "New York", true)
		expect(out.find((p) => p.span.body === "New York")).toBeDefined()
	})
})

describe("scoreVenuePhrase", () => {
	it("emits VENUE_PHRASE on Steakhouse-marked run", () => {
		const out = scoreVenuePhrase(tokenizeSegment("NY-NY Steakhouse", 0), "NY-NY Steakhouse")
		const venue = findKind(out, "VENUE_PHRASE", "NY-NY Steakhouse")
		expect(venue).toBeDefined()
		expect(venue!.confidence).toBeGreaterThanOrEqual(0.8)
	})

	it("emits lower-confidence VENUE_PHRASE on hyphen-compound-only runs", () => {
		const out = scoreVenuePhrase(tokenizeSegment("Coca-Cola Plant", 0), "Coca-Cola Plant")
		const venue = findKind(out, "VENUE_PHRASE")
		expect(venue).toBeDefined()
	})

	it("no venue marker + no hyphen = no VENUE_PHRASE", () => {
		expect(scoreVenuePhrase(tokenizeSegment("Just Words Here", 0), "Just Words Here")).toEqual([])
	})
})

describe("groupPhrases — segment-aware composition", () => {
	it("processes each QueryShape segment independently", () => {
		const text = "350 5th Ave, New York, NY 10118"
		const out = groupPhrasesSync(
			input(text),
			shape({
				segments: [
					{ body: "350 5th Ave", index: 0, span: { start: 0, end: 11 } },
					{ body: "New York", index: 1, span: { start: 13, end: 21 } },
					{ body: "NY 10118", index: 2, span: { start: 23, end: 31 } },
				],
				knownFormats: [{ format: "us_zip", span: { start: 26, end: 31 }, confidence: 0.92 }],
			})
		)
		expect(kinds(out)).toContain("NUMERIC")
		expect(kinds(out)).toContain("STREET_PHRASE")
		expect(kinds(out)).toContain("LOCALITY_PHRASE")
		expect(kinds(out)).toContain("REGION_ABBREVIATION")
		expect(kinds(out)).toContain("POSTCODE")
	})

	it("falls back to single-segment mode when shape.segments is absent", () => {
		const text = "350 5th Ave"
		const out = groupPhrasesSync(input(text), shape())
		expect(kinds(out)).toContain("STREET_PHRASE")
	})
})
