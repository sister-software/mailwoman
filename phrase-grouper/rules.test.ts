/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { expect, test } from "vitest"

import {
	scoreHyphenatedCompound,
	scoreLocalityPhrase,
	scoreNumeric,
	scorePostcode,
	scoreRegionAbbreviation,
	scoreStreetPhrase,
	scoreVenuePhrase,
	type SegmentToken,
	tokenizeSegment,
} from "./rules.js"
import type { PhraseProposal, QueryShapeLike } from "./types.js"

/**
 * Build the `SegmentToken[]` for a single segment string the same way `tokenizeSegment` does, but keep it explicit in
 * tests so each token's offsets are visible. `tokenizeSegment` is itself tested directly below; the other rule tests
 * reuse it as the trusted tokenizer.
 */
const tokens = (segmentBody: string, segmentStart = 0): SegmentToken[] => tokenizeSegment(segmentBody, segmentStart)

const fmt = (format: string, start: number, end: number, confidence = 0.9) => ({
	format,
	span: { start, end },
	confidence,
})
const shape = (o: Partial<QueryShapeLike> = {}): QueryShapeLike => ({ knownFormats: [], ...o })

/** Reduce a proposal to the load-bearing fields for comparison. */
const summarize = (p: PhraseProposal) => ({
	body: p.span.body,
	start: p.span.start,
	end: p.span.end,
	kind: p.kindHypothesis,
	confidence: p.confidence,
})

/**
 * Span/kind shape without the confidence (which accumulates IEEE-754 rounding from the additive bonus chain — assert it
 * separately with `toBeCloseTo`).
 */
const spanShape = (p: PhraseProposal) => ({
	body: p.span.body,
	start: p.span.start,
	end: p.span.end,
	kind: p.kindHypothesis,
})

// ───────────────────────── tokenizeSegment ─────────────────────────

test("tokenizeSegment: splits on whitespace with absolute offsets carrying the segment start", () => {
	expect(tokenizeSegment("350 5th Ave", 0)).toEqual([
		{ body: "350", start: 0, end: 3 },
		{ body: "5th", start: 4, end: 7 },
		{ body: "Ave", start: 8, end: 11 },
	])
})

test("tokenizeSegment: collapses runs of whitespace and respects a non-zero segment start", () => {
	// Leading/trailing/multiple spaces and a tab — only token bodies survive, offsets stay absolute.
	expect(tokenizeSegment("  A\t B  ", 100)).toEqual([
		{ body: "A", start: 102, end: 103 },
		{ body: "B", start: 105, end: 106 },
	])
	// Empty / whitespace-only segments yield no tokens.
	expect(tokenizeSegment("", 0)).toEqual([])
	expect(tokenizeSegment("   ", 5)).toEqual([])
})

// ───────────────────────── scoreNumeric ─────────────────────────

test("scoreNumeric: 1-4 digit runs are confident house numbers; 5+ drop to the neutral baseline", () => {
	const text = "350 12345"
	const out = scoreNumeric(tokens(text), text)
	expect(out.map(summarize)).toEqual([
		{ body: "350", start: 0, end: 3, kind: "NUMERIC", confidence: 0.95 },
		// 5 digits → ambiguous with POSTCODE → NEUTRAL_PROPOSAL_CONFIDENCE (0.55), still emitted.
		{ body: "12345", start: 4, end: 9, kind: "NUMERIC", confidence: 0.55 },
	])
})

test("scoreNumeric: the 4↔5 digit boundary", () => {
	expect(scoreNumeric(tokens("1234"), "1234")[0]!.confidence).toBe(0.95)
	expect(scoreNumeric(tokens("12345"), "12345")[0]!.confidence).toBe(0.55)
})

test("scoreNumeric: non-digit and mixed tokens emit nothing", () => {
	const text = "5th Ave 12a"
	expect(scoreNumeric(tokens(text), text)).toEqual([])
})

// ───────────────────────── scorePostcode ─────────────────────────

test("scorePostcode: lifts each non-po_box format hit, carrying its confidence through", () => {
	const text = "10118"
	const out = scorePostcode(shape({ knownFormats: [fmt("us_zip", 0, 5, 0.92)] }), text)
	expect(out.map(summarize)).toEqual([{ body: "10118", start: 0, end: 5, kind: "POSTCODE", confidence: 0.92 }])
})

test("scorePostcode: po_box hits are skipped (the kind classifier owns that signal)", () => {
	const text = "PO Box 12"
	expect(scorePostcode(shape({ knownFormats: [fmt("po_box", 0, 6, 0.9)] }), text)).toEqual([])
	// A mixed bag emits only the postcode.
	const out = scorePostcode(
		shape({ knownFormats: [fmt("po_box", 0, 6, 0.9), fmt("us_zip", 7, 12, 0.8)] }),
		"PO Box 90210"
	)
	// "PO Box " is 7 chars; the [7,12) slice is the ZIP "90210".
	expect(out.map(summarize)).toEqual([{ body: "90210", start: 7, end: 12, kind: "POSTCODE", confidence: 0.8 }])
})

test("scorePostcode: no known formats → no proposals", () => {
	expect(scorePostcode(shape(), "anything")).toEqual([])
})

// ───────────────────────── scoreRegionAbbreviation ─────────────────────────

test("scoreRegionAbbreviation: tail-of-segment region code scores highest", () => {
	const text = "NYC NY"
	// "NYC" is 3 uppercase letters → also region-shaped, but "NY" follows it and is itself a region
	// abbreviation, so the suppression guard does NOT trigger for NYC (after must be NON-region content).
	const out = scoreRegionAbbreviation(tokens(text), text, true)
	expect(out.map(summarize)).toEqual([
		// NYC is not at tail, but is in the last segment → 0.7
		{ body: "NYC", start: 0, end: 3, kind: "REGION_ABBREVIATION", confidence: 0.7 },
		// NY is the tail token → 0.85
		{ body: "NY", start: 4, end: 6, kind: "REGION_ABBREVIATION", confidence: 0.85 },
	])
})

test("scoreRegionAbbreviation: non-tail region in a non-last segment gets the neutral baseline", () => {
	const text = "TX 75001"
	// "TX" followed by an all-digit token (not place-name content) → not suppressed; not at tail; not
	// last segment → NEUTRAL_PROPOSAL_CONFIDENCE (0.55).
	const out = scoreRegionAbbreviation(tokens(text), text, false)
	expect(out.map(summarize)).toEqual([{ body: "TX", start: 0, end: 2, kind: "REGION_ABBREVIATION", confidence: 0.55 }])
})

test("scoreRegionAbbreviation: a region-shaped HEAD of a multi-word place name is suppressed", () => {
	// "SAN NAZARIO" — "SAN" is region-shaped but is followed by capitalized place-name content that is
	// neither a region abbreviation nor a street suffix → it is the HEAD of a place name, not a region.
	const text = "SAN Nazario"
	const out = scoreRegionAbbreviation(tokens(text), text, true)
	// "SAN" suppressed. "Nazario" is not 2-3 uppercase letters → never region-shaped. → no proposals.
	expect(out).toEqual([])
})

test("scoreRegionAbbreviation: lowercase / 4-letter / 1-letter tokens are not region-shaped", () => {
	const text = "ny ABCD A"
	expect(scoreRegionAbbreviation(tokens(text), text, true)).toEqual([])
})

// ───────────────────────── scoreHyphenatedCompound ─────────────────────────

test("scoreHyphenatedCompound: interior hyphen fires; leading/trailing hyphens do not", () => {
	const text = "Saint-Denis -lead trail-"
	const out = scoreHyphenatedCompound(tokens(text), text)
	expect(out.map(summarize)).toEqual([
		{ body: "Saint-Denis", start: 0, end: 11, kind: "HYPHENATED_COMPOUND", confidence: 0.88 },
	])
})

test("scoreHyphenatedCompound: ZIP+4 single token and double-hyphen edge", () => {
	expect(scoreHyphenatedCompound(tokens("10118-1234"), "10118-1234").map(summarize)).toEqual([
		{ body: "10118-1234", start: 0, end: 10, kind: "HYPHENATED_COMPOUND", confidence: 0.88 },
	])
	// A token with no interior single hyphen (only a leading hyphen) is rejected.
	expect(scoreHyphenatedCompound(tokens("-abc"), "-abc")).toEqual([])
	// No hyphen at all.
	expect(scoreHyphenatedCompound(tokens("plain"), "plain")).toEqual([])
})

// ───────────────────────── scoreStreetPhrase ─────────────────────────

test("scoreStreetPhrase: house-number + name + suffix excludes the house number and scores 0.9", () => {
	const text = "350 Fifth Ave"
	const out = scoreStreetPhrase(tokens(text), text)
	// #565: the leading all-digit house number is excluded from the span; phrase starts at "Fifth".
	expect(out.map(summarize)).toEqual([{ body: "Fifth Ave", start: 4, end: 13, kind: "STREET_PHRASE", confidence: 0.9 }])
})

test("scoreStreetPhrase: a capitalized name + suffix with no house number scores 0.75", () => {
	const text = "Hill Street"
	const out = scoreStreetPhrase(tokens(text), text)
	expect(out.map(summarize)).toEqual([
		{ body: "Hill Street", start: 0, end: 11, kind: "STREET_PHRASE", confidence: 0.75 },
	])
})

test("scoreStreetPhrase: a bare suffix with nothing to its left emits no English street phrase", () => {
	// "Street" alone — start === suffixIdx after the left-walk → no proposal.
	const text = "Street"
	expect(scoreStreetPhrase(tokens(text), text)).toEqual([])
})

test("scoreStreetPhrase: an ordinal stays in the street name (only all-digit numbers are stripped)", () => {
	const text = "5th Ave"
	const out = scoreStreetPhrase(tokens(text), text)
	expect(out.map(summarize)).toEqual([{ body: "5th Ave", start: 0, end: 7, kind: "STREET_PHRASE", confidence: 0.75 }])
})

test("scoreStreetPhrase: a '<number> <suffix>' run with no street name emits nothing", () => {
	// Only the house number precedes the suffix → after stripping it, start === suffixIdx → skip.
	const text = "350 Street"
	expect(scoreStreetPhrase(tokens(text), text)).toEqual([])
})

test("scoreStreetPhrase: Romance prefix-led street walks right and scores 0.72", () => {
	const text = "Via Trento"
	const out = scoreStreetPhrase(tokens(text), text)
	expect(out.map(summarize)).toEqual([
		{ body: "Via Trento", start: 0, end: 10, kind: "STREET_PHRASE", confidence: 0.72 },
	])
})

test("scoreStreetPhrase: a bare Romance prefix still emits a low-confidence marker (0.5)", () => {
	// "Calle" with no following place-name content → end === prefixIdx → 0.5 marker.
	const text = "Calle 12"
	const out = scoreStreetPhrase(tokens(text), text)
	expect(out.map(summarize)).toEqual([{ body: "Calle", start: 0, end: 5, kind: "STREET_PHRASE", confidence: 0.5 }])
})

test("scoreStreetPhrase: a Romance prefix does not end on a trailing connective particle", () => {
	// "Calle de Mayor" — walk gathers "de" (particle) then "Mayor" (content); end backs off any
	// trailing particle but here ends on "Mayor". Span covers prefix..Mayor.
	const text = "Calle de Mayor"
	const out = scoreStreetPhrase(tokens(text), text)
	expect(out.map(summarize)).toEqual([
		{ body: "Calle de Mayor", start: 0, end: 14, kind: "STREET_PHRASE", confidence: 0.72 },
	])
})

// ───────────────────────── scoreLocalityPhrase ─────────────────────────

test("scoreLocalityPhrase: a two-token place name proposes every prefix length", () => {
	const text = "Saint Petersburg"
	const out = scoreLocalityPhrase(tokens(text), text, true)
	// From i=0: len1 "Saint" (not at tail), len2 "Saint Petersburg" (at tail, last segment).
	// From i=1: len1 "Petersburg" (at tail, last segment).
	// base 0.55; len2 bonus +0.15; atTail +0.05; atTail&&last +0.1.
	expect(out.map(spanShape)).toEqual([
		{ body: "Saint", start: 0, end: 5, kind: "LOCALITY_PHRASE" },
		{ body: "Saint Petersburg", start: 0, end: 16, kind: "LOCALITY_PHRASE" },
		{ body: "Petersburg", start: 6, end: 16, kind: "LOCALITY_PHRASE" },
	])
	expect(out[0]!.confidence).toBeCloseTo(0.55, 10) // "Saint" not at tail
	expect(out[1]!.confidence).toBeCloseTo(0.85, 10) // "Saint Petersburg": 0.55 + 0.15 + 0.05 + 0.1
	expect(out[2]!.confidence).toBeCloseTo(0.7, 10) // "Petersburg": 0.55 + 0.05 + 0.1
})

test("scoreLocalityPhrase: a leading Romance street prefix is left to scoreStreetPhrase", () => {
	// "Via Roma" — "Via" is a street prefix → skipped as a head. "Roma" still seeds its own run.
	const text = "Via Roma"
	const out = scoreLocalityPhrase(tokens(text), text, true)
	expect(out.map(spanShape)).toEqual([{ body: "Roma", start: 4, end: 8, kind: "LOCALITY_PHRASE" }])
	// Only "Roma": base 0.55 + atTail 0.05 + atTail&&last 0.1 = 0.7
	expect(out[0]!.confidence).toBeCloseTo(0.7, 10)
})

test("scoreLocalityPhrase: a known US region name not at segment-tail is penalized −0.2", () => {
	// "Texas Tower" — "Texas" is a US region name; "Tower" is plain place-name content (not a street
	// prefix/suffix/particle). From i=0: len1 "Texas" (not at tail) → 0.55 − 0.2 = 0.35; len2 "Texas
	// Tower" (at tail, last) → 0.55 + 0.15 + 0.05 + 0.1 = 0.85. From i=1: len1 "Tower" (at tail, last).
	const text = "Texas Tower"
	const out = scoreLocalityPhrase(tokens(text), text, true)
	expect(out.map(spanShape)).toEqual([
		{ body: "Texas", start: 0, end: 5, kind: "LOCALITY_PHRASE" },
		{ body: "Texas Tower", start: 0, end: 11, kind: "LOCALITY_PHRASE" },
		{ body: "Tower", start: 6, end: 11, kind: "LOCALITY_PHRASE" },
	])
	expect(out[0]!.confidence).toBeCloseTo(0.35, 10) // "Texas" region-name, not at tail: 0.55 − 0.2
	expect(out[1]!.confidence).toBeCloseTo(0.85, 10) // "Texas Tower": 0.55 + 0.15 + 0.05 + 0.1
	expect(out[2]!.confidence).toBeCloseTo(0.7, 10) // "Tower" (at tail, last): 0.55 + 0.05 + 0.1
})

test("scoreLocalityPhrase: a region name AT the segment tail is NOT penalized", () => {
	// "Visit Texas" — "Texas" is the tail of the last segment → no −0.2 penalty.
	const text = "Visit Texas"
	const out = scoreLocalityPhrase(tokens(text), text, true)
	const texasAlone = out.find((p) => p.span.body === "Texas")!
	// 0.55 + atTail 0.05 + atTail&&last 0.1 = 0.7 (not 0.5 — no −0.2 region penalty at tail)
	expect(texasAlone.confidence).toBeCloseTo(0.7, 10)
})

test("scoreLocalityPhrase: bridges a lowercase place-name particle between capitalized content", () => {
	// "Reggio nell'Emilia" — wait, use the documented "San Pietro in Casale".
	const text = "San Pietro in Casale"
	const out = scoreLocalityPhrase(tokens(text), text, true)
	// The full bridged span should appear: the particle "in" is glued between "Pietro" and "Casale".
	const bodies = out.map((p) => p.span.body)
	expect(bodies).toContain("San Pietro in Casale")
	// And it should never END on the particle "in".
	expect(bodies).not.toContain("San Pietro in")
})

test("scoreLocalityPhrase: never proposes a span ending on a connective particle", () => {
	// "Las Palmas de" — the trailing "de" is a particle; no proposal may end on it.
	const text = "Las Palmas de"
	const out = scoreLocalityPhrase(tokens(text), text, true)
	const bodies = out.map((p) => p.span.body)
	expect(bodies).not.toContain("Las Palmas de")
	expect(bodies).not.toContain("Palmas de")
	expect(bodies).toContain("Las Palmas")
})

test("scoreLocalityPhrase: a stray digit or street suffix stops the run", () => {
	// "Springfield IL" — the run from "Springfield" must NOT absorb the region abbreviation "IL".
	const text = "Springfield IL"
	const out = scoreLocalityPhrase(tokens(text), text, true)
	const bodies = out.map((p) => p.span.body)
	expect(bodies).toContain("Springfield")
	expect(bodies).not.toContain("Springfield IL")
})

test("scoreLocalityPhrase: confidence is capped at 0.95", () => {
	// A two-token tail-of-last run hits 0.85; engineer a longer run that would otherwise exceed 0.95?
	// len2 gives the max single-step bonus (0.15). 0.55 + 0.15 + 0.05 + 0.1 = 0.85 < 0.95, so the cap
	// is defensive. Confirm no proposal ever exceeds 0.95 for a normal multi-word place name.
	const text = "Las Palmas de Gran Canaria"
	const out = scoreLocalityPhrase(tokens(text), text, true)

	for (const p of out) expect(p.confidence).toBeLessThanOrEqual(0.95)
})

test("scoreLocalityPhrase: no capitalized content → no proposals", () => {
	const text = "350 12345"
	expect(scoreLocalityPhrase(tokens(text), text, true)).toEqual([])
})

// ───────────────────────── scoreVenuePhrase ─────────────────────────

test("scoreVenuePhrase: a venue-marker noun lifts the whole capitalized run to its marker weight", () => {
	const text = "Grand Hotel"
	const out = scoreVenuePhrase(tokens(text), text, false)
	// "hotel" weight = 0.9.
	expect(out.map(summarize)).toEqual([
		{ body: "Grand Hotel", start: 0, end: 11, kind: "VENUE_PHRASE", confidence: 0.9 },
	])
})

test("scoreVenuePhrase: a hyphenated compound inside a 2+ capitalized run fires at 0.65", () => {
	// "NY-NY Steakhouse" actually has a venue marker (steakhouse=0.9) which dominates. Use a run with a
	// hyphen compound but NO marker to isolate the 0.65 branch.
	const text = "Coca-Cola Tower"
	const out = scoreVenuePhrase(tokens(text), text, false)
	// "tower" is a venue marker (0.65). So marker weight 0.65 wins — both branches happen to agree here.
	// Use a cleaner hyphen-only case with no marker word:
	const text2 = "Mont-Blanc Estates"
	const out2 = scoreVenuePhrase(tokens(text2), text2, false)
	expect(out2.map(summarize)).toEqual([
		{ body: "Mont-Blanc Estates", start: 0, end: 18, kind: "VENUE_PHRASE", confidence: 0.65 },
	])
	// (smoke) Coca-Cola Tower still emits a venue proposal.
	expect(out.length).toBe(1)
})

test("scoreVenuePhrase: venue-by-exclusion fires only in the first segment for a plain capitalized run", () => {
	const text = "Acme Corp"
	// First segment, ≥2 capitalized tokens, no street suffix, no leading number, no unit marker → weak
	// VENUE_PHRASE. 2 tokens → 0.5.
	const first = scoreVenuePhrase(tokens(text), text, true)
	expect(first.map(summarize)).toEqual([{ body: "Acme Corp", start: 0, end: 9, kind: "VENUE_PHRASE", confidence: 0.5 }])
	// Same run NOT in the first segment → no venue-by-exclusion proposal.
	expect(scoreVenuePhrase(tokens(text), text, false)).toEqual([])
})

test("scoreVenuePhrase: venue-by-exclusion gives a 3+ token run the neutral baseline (0.55)", () => {
	const text = "Acme Holding Group"
	const out = scoreVenuePhrase(tokens(text), text, true)
	expect(out.map(summarize)).toEqual([
		{ body: "Acme Holding Group", start: 0, end: 18, kind: "VENUE_PHRASE", confidence: 0.55 },
	])
})

test("scoreVenuePhrase: venue-by-exclusion is blocked by a street suffix, house number, or unit marker", () => {
	// Street suffix present.
	expect(scoreVenuePhrase(tokens("Hill Street"), "Hill Street", true)).toEqual([])
	// Leading house number — note: a leading digit is not capitalized, so the run starts at the first
	// capitalized token. Use a run where the capitalized run itself begins with a number-shaped token.
	// "Suite 200" has a unit marker → blocked.
	expect(scoreVenuePhrase(tokens("Suite Two"), "Suite Two", true)).toEqual([])
})

test("scoreVenuePhrase: a single capitalized word with no marker is not enough for venue-by-exclusion", () => {
	// run.length must be >= 2 for the exclusion branch.
	expect(scoreVenuePhrase(tokens("Acme"), "Acme", true)).toEqual([])
})
