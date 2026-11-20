// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Interface + per-rule unit tests for the rule-based grouper.
 *
 *   The kryptonite-catalogue fixture test (operator's adversarial examples) lives in `kryptonite.test.ts`.
 */

import type { PhraseProposal } from "@mailwoman/core/pipeline"
import {
	EMPTY_QUERY_SHAPE_VIEW,
	type NormalizedInputLite,
	type QueryShapeTokensView as QueryShapeLike,
} from "@mailwoman/core/pipeline/types"
import { describe, expect, it } from "vitest"

import { groupPhrasesSync } from "#group"
import {
	scoreHyphenatedCompound,
	scoreLocalityPhrase,
	scoreNumeric,
	scoreRegionAbbreviation,
	scoreStreetPhrase,
	scoreVenuePhrase,
	tokenizeSegment,
} from "#rules"

function input(normalized: string): NormalizedInputLite {
	return { raw: normalized, normalized }
}

function shape(opts: Partial<QueryShapeLike> = {}): QueryShapeLike {
	return { ...EMPTY_QUERY_SHAPE_VIEW, ...opts }
}

function kinds(proposals: PhraseProposal[]): string[] {
	return proposals.map((p) => p.kindHypothesis)
}

function findKind(proposals: PhraseProposal[], kind: string, body?: string): PhraseProposal | null {
	return proposals.find((p) => p.kindHypothesis === kind && (!body || p.span.body === body)) ?? null
}

describe("phrase-grouper — interface", () => {
	it("empty input returns empty list", () => {
		expect(groupPhrasesSync(input(""), shape())).toEqual([])
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
})

describe("scoreStreetPhrase", () => {
	it("emits STREET_PHRASE without leading numeric at lower confidence", () => {
		const out = scoreStreetPhrase(tokenizeSegment("Main Street", 0), "Main Street")
		expect(out).toHaveLength(1)
		expect(out[0]!.confidence).toBeLessThan(0.9)
	})

	// Romance street pattern: the street type leads ("Via Trento", "Calle Mayor").
	it("emits STREET_PHRASE for a prefix-led Spanish street (Calle Mayor)", () => {
		const out = scoreStreetPhrase(tokenizeSegment("Calle Mayor", 0), "Calle Mayor")
		expect(out.find((p) => p.span.body === "Calle Mayor")).toBeDefined()
	})

	it("a bare street prefix still emits a low-confidence STREET marker (audit anchor)", () => {
		const out = scoreStreetPhrase(tokenizeSegment("Via", 0), "Via")
		const via = out.find((p) => p.span.body === "Via")
		expect(via).toBeDefined()
		expect(via!.confidence).toBeLessThan(0.6)
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

	// Bridge lowercase place-name particles and apostrophe-fused names so native-order
	// multi-word localities surface as one span.
	it("bridges a Spanish 'de' particle (Las Palmas de Gran Canaria)", () => {
		const text = "Las Palmas de Gran Canaria"
		const bodies = scoreLocalityPhrase(tokenizeSegment(text, 0), text, true).map((p) => p.span.body)
		expect(bodies).toContain("Las Palmas de Gran Canaria")
		// Never end a proposal on the bare particle.
		expect(bodies).not.toContain("Las Palmas de")
	})

	it("bridges an apostrophe-fused Italian particle (Reggio nell'Emilia)", () => {
		const text = "Reggio nell'Emilia"
		const bodies = scoreLocalityPhrase(tokenizeSegment(text, 0), text, true).map((p) => p.span.body)
		expect(bodies).toContain("Reggio nell'Emilia")
	})

	it("bridges two consecutive Dutch particles (Alphen aan den Rijn)", () => {
		const text = "Alphen aan den Rijn"
		const bodies = scoreLocalityPhrase(tokenizeSegment(text, 0), text, true).map((p) => p.span.body)
		expect(bodies).toContain("Alphen aan den Rijn")
	})

	it("bridges a German 'am' particle (Frankfurt am Main)", () => {
		const text = "Frankfurt am Main"
		const bodies = scoreLocalityPhrase(tokenizeSegment(text, 0), text, true).map((p) => p.span.body)
		expect(bodies).toContain("Frankfurt am Main")
	})

	it("does NOT bridge a non-particle lowercase word (no 'Street and Oak' span)", () => {
		const text = "Main Street and Oak Avenue"
		const bodies = scoreLocalityPhrase(tokenizeSegment(text, 0), text, true).map((p) => p.span.body)
		expect(bodies.some((b) => b.includes(" and "))).toBe(false)
	})

	// An all-caps intl place head that matches the region-abbreviation shape ("SAN", "DI") must
	// still form the multi-word locality rather than get skipped as a US-state abbreviation.
	it("forms a locality from a region-abbrev-shaped head (SAN NAZARIO)", () => {
		const bodies = scoreLocalityPhrase(tokenizeSegment("SAN NAZARIO", 0), "SAN NAZARIO", true).map((p) => p.span.body)
		expect(bodies).toContain("SAN NAZARIO")
	})

	it("bridges an all-caps particle (CITTA DI CASTELLO)", () => {
		const bodies = scoreLocalityPhrase(tokenizeSegment("CITTA DI CASTELLO", 0), "CITTA DI CASTELLO", true).map(
			(p) => p.span.body
		)

		expect(bodies).toContain("CITTA DI CASTELLO")
		expect(bodies).not.toContain("CITTA DI")
	})

	it("does NOT start a locality on a leading street-type word (Via Trento)", () => {
		const bodies = scoreLocalityPhrase(tokenizeSegment("Via Trento", 0), "Via Trento", false).map((p) => p.span.body)
		expect(bodies).not.toContain("Via")
		expect(bodies).not.toContain("Via Trento")
		// The street name by itself may still surface as a locality candidate.
		// The reconciler arbitrates.
		expect(bodies).toContain("Trento")
	})
})

describe("scoreVenuePhrase", () => {
	it("emits VENUE_PHRASE on Steakhouse-marked run", () => {
		const out = scoreVenuePhrase(tokenizeSegment("NY-NY Steakhouse", 0), "NY-NY Steakhouse")
		const venue = findKind(out, "VENUE_PHRASE", "NY-NY Steakhouse")
		expect(venue).toBeDefined()
		expect(venue!.confidence).toBeGreaterThanOrEqual(0.8)
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
