import type { PhraseProposal } from "@mailwoman/core/pipeline"
import {
	hasUnitMarker,
	scoreHyphenatedCompound,
	scoreLocalityPhrase,
	scoreNumeric,
	scorePostcode,
	scoreRegionAbbreviation,
	scoreStreetPhrase,
	scoreVenuePhrase,
	type SegmentToken,
	tokenizeSegment,
} from "@mailwoman/phrase-grouper/rules"
import type { KnownFormat, QueryShapeTokensView as QueryShapeLike } from "@mailwoman/query-shape"
import { expect, test } from "vitest"

const tokens = (segmentBody: string, segmentStart = 0): SegmentToken[] => tokenizeSegment(segmentBody, segmentStart)

const fmt = (format: KnownFormat, start: number, end: number, confidence = 0.9) => ({
	format,
	span: { start, end },
	confidence,
})

const shape = (o: Partial<QueryShapeLike> = {}): QueryShapeLike => ({ knownFormats: [], ...o })

const summarize = (p: PhraseProposal) => ({
	body: p.span.body,
	start: p.span.start,
	end: p.span.end,
	kind: p.kindHypothesis,
	confidence: p.confidence,
})

const spanShape = (p: PhraseProposal) => ({
	body: p.span.body,
	start: p.span.start,
	end: p.span.end,
	kind: p.kindHypothesis,
})

test("tokenizeSegment: splits on whitespace with absolute offsets carrying the segment start", () => {
	expect(tokenizeSegment("350 5th Ave", 0)).toEqual([
		{ body: "350", start: 0, end: 3 },
		{ body: "5th", start: 4, end: 7 },
		{ body: "Ave", start: 8, end: 11 },
	])
})

test("tokenizeSegment: collapses runs of whitespace and respects a non-zero segment start", () => {
	expect(tokenizeSegment("  A\t B  ", 100)).toEqual([
		{ body: "A", start: 102, end: 103 },
		{ body: "B", start: 105, end: 106 },
	])

	expect(tokenizeSegment("", 0)).toEqual([])
	expect(tokenizeSegment("   ", 5)).toEqual([])
})

test("scoreNumeric: 1-4 digit runs are confident house numbers; 5+ drop to the neutral baseline", () => {
	const text = "350 12345"
	const out = scoreNumeric(tokens(text), text)

	expect(out.map(summarize)).toEqual([
		{ body: "350", start: 0, end: 3, kind: "NUMERIC", confidence: 0.95 },

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

test("scorePostcode: lifts each non-po_box format hit, carrying its confidence through", () => {
	const text = "10118"
	const out = scorePostcode(shape({ knownFormats: [fmt("us_zip", 0, 5, 0.92)] }), text)
	expect(out.map(summarize)).toEqual([{ body: "10118", start: 0, end: 5, kind: "POSTCODE", confidence: 0.92 }])
})

test("scorePostcode: po_box hits are skipped (the kind classifier owns that signal)", () => {
	const text = "PO Box 12"
	expect(scorePostcode(shape({ knownFormats: [fmt("po_box", 0, 6, 0.9)] }), text)).toEqual([])

	const out = scorePostcode(
		shape({ knownFormats: [fmt("po_box", 0, 6, 0.9), fmt("us_zip", 7, 12, 0.8)] }),
		"PO Box 90210"
	)

	expect(out.map(summarize)).toEqual([{ body: "90210", start: 7, end: 12, kind: "POSTCODE", confidence: 0.8 }])
})

test("ScorePostcode: no known formats → no proposals", () => {
	expect(scorePostcode(shape(), "anything")).toEqual([])
})

test("scoreRegionAbbreviation: tail-of-segment region code scores highest", () => {
	const text = "NYC NY"

	const out = scoreRegionAbbreviation(tokens(text), text, true)

	expect(out.map(summarize)).toEqual([
		{ body: "NYC", start: 0, end: 3, kind: "REGION_ABBREVIATION", confidence: 0.7 },

		{ body: "NY", start: 4, end: 6, kind: "REGION_ABBREVIATION", confidence: 0.85 },
	])
})

test("scoreRegionAbbreviation: non-tail region in a non-last segment gets the neutral baseline", () => {
	const text = "TX 75001"

	const out = scoreRegionAbbreviation(tokens(text), text, false)
	expect(out.map(summarize)).toEqual([{ body: "TX", start: 0, end: 2, kind: "REGION_ABBREVIATION", confidence: 0.55 }])
})

test("scoreRegionAbbreviation: a region-shaped HEAD of a multi-word place name is suppressed", () => {
	const text = "SAN Nazario"
	const out = scoreRegionAbbreviation(tokens(text), text, true)

	expect(out).toEqual([])
})

test("scoreRegionAbbreviation: lowercase / 4-letter / 1-letter tokens are not region-shaped", () => {
	const text = "ny ABCD A"
	expect(scoreRegionAbbreviation(tokens(text), text, true)).toEqual([])
})

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

	expect(scoreHyphenatedCompound(tokens("-abc"), "-abc")).toEqual([])

	expect(scoreHyphenatedCompound(tokens("plain"), "plain")).toEqual([])
})

test("scoreStreetPhrase: house-number + name + suffix excludes the house number and scores 0.9", () => {
	const text = "350 Fifth Ave"
	const out = scoreStreetPhrase(tokens(text), text)

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
	const text = "Street"
	expect(scoreStreetPhrase(tokens(text), text)).toEqual([])
})

test("scoreStreetPhrase: an ordinal stays in the street name (only all-digit numbers are stripped)", () => {
	const text = "5th Ave"
	const out = scoreStreetPhrase(tokens(text), text)
	expect(out.map(summarize)).toEqual([{ body: "5th Ave", start: 0, end: 7, kind: "STREET_PHRASE", confidence: 0.75 }])
})

test("scoreStreetPhrase: a '<number> <suffix>' run with no street name emits nothing", () => {
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
	const text = "Calle 12"
	const out = scoreStreetPhrase(tokens(text), text)
	expect(out.map(summarize)).toEqual([{ body: "Calle", start: 0, end: 5, kind: "STREET_PHRASE", confidence: 0.5 }])
})

test("scoreStreetPhrase: a Romance prefix does not end on a trailing connective particle", () => {
	const text = "Calle de Mayor"
	const out = scoreStreetPhrase(tokens(text), text)

	expect(out.map(summarize)).toEqual([
		{ body: "Calle de Mayor", start: 0, end: 14, kind: "STREET_PHRASE", confidence: 0.72 },
	])
})

test("scoreLocalityPhrase: a two-token place name proposes every prefix length", () => {
	const text = "Saint Petersburg"
	const out = scoreLocalityPhrase(tokens(text), text, true)

	expect(out.map(spanShape)).toEqual([
		{ body: "Saint", start: 0, end: 5, kind: "LOCALITY_PHRASE" },
		{ body: "Saint Petersburg", start: 0, end: 16, kind: "LOCALITY_PHRASE" },
		{ body: "Petersburg", start: 6, end: 16, kind: "LOCALITY_PHRASE" },
	])

	expect(out[0]!.confidence).toBeCloseTo(0.55, 10)
	expect(out[1]!.confidence).toBeCloseTo(0.85, 10)
	expect(out[2]!.confidence).toBeCloseTo(0.7, 10)
})

test("scoreLocalityPhrase: a leading Romance street prefix is left to scoreStreetPhrase", () => {
	const text = "Via Roma"
	const out = scoreLocalityPhrase(tokens(text), text, true)
	expect(out.map(spanShape)).toEqual([{ body: "Roma", start: 4, end: 8, kind: "LOCALITY_PHRASE" }])

	expect(out[0]!.confidence).toBeCloseTo(0.7, 10)
})

test("scoreLocalityPhrase: a known US region name not at segment-tail is penalized −0.2", () => {
	const text = "Texas Tower"
	const out = scoreLocalityPhrase(tokens(text), text, true)

	expect(out.map(spanShape)).toEqual([
		{ body: "Texas", start: 0, end: 5, kind: "LOCALITY_PHRASE" },
		{ body: "Texas Tower", start: 0, end: 11, kind: "LOCALITY_PHRASE" },
		{ body: "Tower", start: 6, end: 11, kind: "LOCALITY_PHRASE" },
	])

	expect(out[0]!.confidence).toBeCloseTo(0.35, 10)
	expect(out[1]!.confidence).toBeCloseTo(0.85, 10)
	expect(out[2]!.confidence).toBeCloseTo(0.7, 10)
})

test("scoreLocalityPhrase: a region name AT the segment tail is NOT penalized", () => {
	const text = "Visit Texas"
	const out = scoreLocalityPhrase(tokens(text), text, true)
	const texasAlone = out.find((p) => p.span.body === "Texas")!

	expect(texasAlone.confidence).toBeCloseTo(0.7, 10)
})

test("scoreLocalityPhrase: bridges a lowercase place-name particle between capitalized content", () => {
	const text = "San Pietro in Casale"
	const out = scoreLocalityPhrase(tokens(text), text, true)

	const bodies = out.map((p) => p.span.body)
	expect(bodies).toContain("San Pietro in Casale")

	expect(bodies).not.toContain("San Pietro in")
})

test("scoreLocalityPhrase: never proposes a span ending on a connective particle", () => {
	const text = "Las Palmas de"
	const out = scoreLocalityPhrase(tokens(text), text, true)
	const bodies = out.map((p) => p.span.body)
	expect(bodies).not.toContain("Las Palmas de")
	expect(bodies).not.toContain("Palmas de")
	expect(bodies).toContain("Las Palmas")
})

test("scoreLocalityPhrase: a stray digit or street suffix stops the run", () => {
	const text = "Springfield IL"
	const out = scoreLocalityPhrase(tokens(text), text, true)
	const bodies = out.map((p) => p.span.body)
	expect(bodies).toContain("Springfield")
	expect(bodies).not.toContain("Springfield IL")
})

test("scoreLocalityPhrase: confidence is capped at 0.95", () => {
	const text = "Las Palmas de Gran Canaria"
	const out = scoreLocalityPhrase(tokens(text), text, true)

	for (const p of out) {
		expect(p.confidence).toBeLessThanOrEqual(0.95)
	}
})

test("ScoreLocalityPhrase: no capitalized content → no proposals", () => {
	const text = "350 12345"
	expect(scoreLocalityPhrase(tokens(text), text, true)).toEqual([])
})

test("scoreVenuePhrase: a venue-marker noun lifts the whole capitalized run to its marker weight", () => {
	const text = "Grand Hotel"
	const out = scoreVenuePhrase(tokens(text), text, false)

	expect(out.map(summarize)).toEqual([
		{ body: "Grand Hotel", start: 0, end: 11, kind: "VENUE_PHRASE", confidence: 0.9 },
	])
})

test("scoreVenuePhrase: a hyphenated compound inside a 2+ capitalized run fires at 0.65", () => {
	const text = "Coca-Cola Tower"
	const out = scoreVenuePhrase(tokens(text), text, false)

	const text2 = "Mont-Blanc Estates"
	const out2 = scoreVenuePhrase(tokens(text2), text2, false)

	expect(out2.map(summarize)).toEqual([
		{ body: "Mont-Blanc Estates", start: 0, end: 18, kind: "VENUE_PHRASE", confidence: 0.65 },
	])

	expect(out).toHaveLength(1)
})

test("scoreVenuePhrase: venue-by-exclusion fires only in the first segment for a plain capitalized run", () => {
	const text = "Acme Corp"

	const first = scoreVenuePhrase(tokens(text), text, true)
	expect(first.map(summarize)).toEqual([{ body: "Acme Corp", start: 0, end: 9, kind: "VENUE_PHRASE", confidence: 0.5 }])

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
	expect(scoreVenuePhrase(tokens("Hill Street"), "Hill Street", true)).toEqual([])

	expect(scoreVenuePhrase(tokens("Suite Two"), "Suite Two", true)).toEqual([])
})

test("scoreVenuePhrase: a single capitalized word with no marker is not enough for venue-by-exclusion", () => {
	expect(scoreVenuePhrase(tokens("Acme"), "Acme", true)).toEqual([])
})

test("hasUnitMarker: every entry of the previous local marker set still matches", () => {
	const legacyMarkers = [
		"apt",
		"apt.",
		"apartment",
		"unit",
		"ste",
		"ste.",
		"suite",
		"room",
		"rm",
		"rm.",
		"floor",
		"fl",
		"fl.",
		"bldg",
		"bldg.",
		"building",
		"dept",
		"dept.",
		"department",
		"#",
	]

	for (const marker of legacyMarkers) {
		expect(hasUnitMarker(tokens(`${marker} 4B`)), marker).toBe(true)
		expect(hasUnitMarker(tokens(`${marker.toUpperCase()} 4B`)), marker.toUpperCase()).toBe(true)
	}

	expect(hasUnitMarker(tokens("Grand Hotel"))).toBe(false)
})
