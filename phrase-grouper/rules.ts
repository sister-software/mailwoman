/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Rule-based scorers for Stage 2.7 phrase grouping. Each rule inspects the tokenized segment +
 *   QueryShape priors and emits zero or more `PhraseProposal`s with a confidence in [0, 1].
 *
 *   Bitter-lesson-safe: only universal structural cues (proximity, punctuation, capitalization,
 *   hyphenation, format-shape repetition). No place-name dictionaries — a `LOCALITY_PHRASE`
 *   proposal means "this looks shaped like a multi-word capitalized run that COULD be a city name",
 *   not "this IS a city name". Typing the span is the classifier's job; this layer only answers "do
 *   these tokens belong together?".
 *
 *   Per "possibilities not constraints", rules emit overlapping proposals freely. The reconciler
 *   (Stage 5) picks the best non-overlapping subset.
 */

import { Span } from "@mailwoman/core/tokenization"
import type { PhraseProposal, QueryShapeLike } from "./types.js"

/**
 * One token within a segment — absolute offsets into the normalized input. Built by
 * `tokenizeSegment` from a (segment-text, segment-start) pair.
 */
export interface SegmentToken {
	body: string
	start: number
	end: number
}

const WHITESPACE = /\s+/

const US_REGION_NAMES: ReadonlySet<string> = new Set([
	"alabama",
	"alaska",
	"arizona",
	"arkansas",
	"california",
	"colorado",
	"connecticut",
	"delaware",
	"florida",
	"georgia",
	"hawaii",
	"idaho",
	"illinois",
	"indiana",
	"iowa",
	"kansas",
	"kentucky",
	"louisiana",
	"maine",
	"maryland",
	"massachusetts",
	"michigan",
	"minnesota",
	"mississippi",
	"missouri",
	"montana",
	"nebraska",
	"nevada",
	"ohio",
	"oklahoma",
	"oregon",
	"pennsylvania",
	"tennessee",
	"texas",
	"utah",
	"vermont",
	"virginia",
	"washington",
	"wisconsin",
	"wyoming",
])

/**
 * Split a segment body into whitespace-separated tokens. Offsets are absolute into the original
 * input (caller supplies the segment's `start` offset).
 */
export function tokenizeSegment(segmentBody: string, segmentStart: number): SegmentToken[] {
	const tokens: SegmentToken[] = []
	let i = 0
	while (i < segmentBody.length) {
		while (i < segmentBody.length && WHITESPACE.test(segmentBody[i]!)) i++
		if (i >= segmentBody.length) break
		const start = i
		while (i < segmentBody.length && !WHITESPACE.test(segmentBody[i]!)) i++
		tokens.push({
			body: segmentBody.slice(start, i),
			start: segmentStart + start,
			end: segmentStart + i,
		})
	}
	return tokens
}

/** Build a `Section` (Span instance) from absolute offsets into the original text. */
function makeSection(text: string, start: number, end: number): Span {
	return Span.from(text.slice(start, end), { start })
}

/** True when token body is non-empty digits only. */
function isAllDigit(s: string): boolean {
	return s.length > 0 && /^[0-9]+$/.test(s)
}

/** True when token body is 2-3 uppercase Latin letters (US state, Canadian province abbreviation). */
function isRegionAbbreviation(s: string): boolean {
	return /^[A-Z]{2,3}$/.test(s)
}

/** True when token starts with an uppercase letter — common Western proper-noun shape. */
function startsCapitalized(s: string): boolean {
	return /^[A-Z]/.test(s)
}

/**
 * Common street-type suffixes (en-US + en-GB + abbreviated forms). Match case-insensitively against
 * the raw token body. The set is intentionally short — coverage extension belongs in a future
 * per-locale rule pack, not as a 500-entry dictionary in this rule.
 */
const STREET_SUFFIXES: ReadonlySet<string> = new Set([
	"st",
	"st.",
	"street",
	"ave",
	"ave.",
	"avenue",
	"blvd",
	"blvd.",
	"boulevard",
	"rd",
	"rd.",
	"road",
	"ln",
	"ln.",
	"lane",
	"dr",
	"dr.",
	"drive",
	"way",
	"pl",
	"pl.",
	"place",
	"ct",
	"ct.",
	"court",
	"pkwy",
	"parkway",
	"hwy",
	"highway",
	"ter",
	"terrace",
	"cir",
	"circle",
	"sq",
	"square",
	"trl",
	"trail",
])

function isStreetSuffix(token: string): boolean {
	return STREET_SUFFIXES.has(token.toLowerCase())
}

/**
 * Venue-marker nouns with per-term confidence weights. Same caveat as STREET_SUFFIXES — universal
 * structural markers, not a places dictionary. Higher weight = stronger venue signal.
 */
const VENUE_MARKERS: ReadonlyMap<string, number> = new Map([
	// Dining (0.90 — unambiguous venue markers)
	["steakhouse", 0.9],
	["restaurant", 0.9],
	["bistro", 0.9],
	["diner", 0.85],
	["cafe", 0.85],
	["café", 0.85],
	["grill", 0.8],
	["pizzeria", 0.9],
	["bakery", 0.85],
	["brewery", 0.85],
	["winery", 0.85],
	["tavern", 0.8],
	["pub", 0.75],
	["bar", 0.7],
	// Lodging
	["hotel", 0.9],
	["motel", 0.9],
	["inn", 0.75],
	["resort", 0.85],
	["lodge", 0.75],
	["hostel", 0.85],
	// Entertainment / culture
	["theater", 0.85],
	["theatre", 0.85],
	["cinema", 0.85],
	["stadium", 0.9],
	["arena", 0.85],
	["museum", 0.85],
	["gallery", 0.75],
	["casino", 0.85],
	["lounge", 0.7],
	// Retail / commercial
	["market", 0.7],
	["mall", 0.8],
	["plaza", 0.7],
	["tower", 0.65],
	["center", 0.6],
	["centre", 0.6],
	// Medical / institutional
	["hospital", 0.9],
	["clinic", 0.85],
	["pharmacy", 0.85],
	// Education
	["university", 0.9],
	["college", 0.85],
	["school", 0.8],
	["academy", 0.8],
	// Civic / religious
	["church", 0.8],
	["temple", 0.8],
	["mosque", 0.8],
	["synagogue", 0.85],
	["cathedral", 0.85],
	["chapel", 0.75],
	["library", 0.85],
	// Outdoor
	["park", 0.6],
	["gardens", 0.65],
	["ranch", 0.7],
	["farm", 0.65],
])

/**
 * Unit-designator tokens that gate the venue-by-exclusion heuristic. When any token in a segment
 * matches one of these, the segment is likely a unit/suite line, not a venue name.
 */
const UNIT_MARKERS: ReadonlySet<string> = new Set([
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
])

function venueMarkerWeight(tokens: ReadonlyArray<SegmentToken>): number {
	let maxWeight = 0
	for (const t of tokens) {
		const w = VENUE_MARKERS.get(t.body.toLowerCase())
		if (w !== undefined && w > maxWeight) maxWeight = w
	}
	return maxWeight
}

function hasUnitMarker(tokens: ReadonlyArray<SegmentToken>): boolean {
	return tokens.some((t) => UNIT_MARKERS.has(t.body.toLowerCase()))
}

/**
 * `NUMERIC` rule: emit one proposal per all-digit token. House numbers, postcodes (when no format
 * hit), unit numbers all surface here as a base hypothesis.
 *
 * Confidence drops for very long runs (5+ digits) where POSTCODE will typically win; the reconciler
 * does the final pick.
 */
export function scoreNumeric(tokens: ReadonlyArray<SegmentToken>, text: string): PhraseProposal[] {
	const out: PhraseProposal[] = []
	for (const t of tokens) {
		if (!isAllDigit(t.body)) continue
		const len = t.body.length
		// 1-4 digit pure-numerics are clearly NUMERIC (house number). 5+ are ambiguous with POSTCODE
		// — emit anyway at lower confidence so the reconciler sees both options.
		const confidence = len <= 4 ? 0.95 : 0.55
		out.push({
			span: makeSection(text, t.start, t.end),
			kindHypothesis: "NUMERIC",
			confidence,
		})
	}
	return out
}

/**
 * `POSTCODE` rule: lift each `QueryShape.knownFormats` postcode hit directly. The QueryShape stage
 * already did the format-shape recognition — Stage 2.7's job is just to publish the spans as phrase
 * proposals so the reconciler can use them.
 */
export function scorePostcode(shape: QueryShapeLike, text: string): PhraseProposal[] {
	const out: PhraseProposal[] = []
	for (const hit of shape.knownFormats) {
		// `po_box` is not a postcode; the kind classifier owns that signal. Skip non-postcode
		// formats here so we don't pollute POSTCODE proposals.
		if (hit.format === "po_box") continue
		out.push({
			span: makeSection(text, hit.span.start, hit.span.end),
			kindHypothesis: "POSTCODE",
			// Lift the format-hit confidence directly — Stage 5 can weight it against alternatives.
			confidence: hit.confidence,
		})
	}
	return out
}

/**
 * `REGION_ABBREVIATION` rule: 2-3 uppercase Latin letters. Tail-of-segment position boosts
 * confidence because that's the canonical "City, ST ZIP" shape.
 */
export function scoreRegionAbbreviation(
	tokens: ReadonlyArray<SegmentToken>,
	text: string,
	segmentIsLast: boolean
): PhraseProposal[] {
	const out: PhraseProposal[] = []
	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i]!
		if (!isRegionAbbreviation(t.body)) continue
		// Position cue: last token in a segment (canonical region slot) → high confidence. Anywhere
		// else, moderate. Anywhere in the LAST segment → slightly elevated (region is canonically the
		// final non-postcode component).
		const atTail = i === tokens.length - 1
		const confidence = atTail ? 0.85 : segmentIsLast ? 0.7 : 0.55
		out.push({
			span: makeSection(text, t.start, t.end),
			kindHypothesis: "REGION_ABBREVIATION",
			confidence,
		})
	}
	return out
}

/**
 * `HYPHENATED_COMPOUND` rule: tokens containing an internal hyphen. Captures `NY-NY` (venue
 * disambiguation case), `Saint-Denis` (French locality compound), `10118-1234` (ZIP+4 written as a
 * single token).
 *
 * Internal hyphen is the cue; the rule doesn't pre-judge what the compound MEANS — that's typing
 * (classifier) or reconcile work. A high confidence here just says "this is one unit, not two".
 */
export function scoreHyphenatedCompound(tokens: ReadonlyArray<SegmentToken>, text: string): PhraseProposal[] {
	const out: PhraseProposal[] = []
	for (const t of tokens) {
		if (!t.body.includes("-")) continue
		// Skip leading/trailing hyphens (likely punctuation drift) — require an interior hyphen
		// surrounded by non-hyphen characters.
		if (!/[^-]-[^-]/.test(t.body)) continue
		out.push({
			span: makeSection(text, t.start, t.end),
			kindHypothesis: "HYPHENATED_COMPOUND",
			confidence: 0.88,
		})
	}
	return out
}

/**
 * `STREET_PHRASE` rule: a token run that contains a street-type suffix. The span covers a leading
 * numeric (house number) when present, through the suffix token.
 *
 * Confidence reflects how canonical the run looks: NUMERIC + 1-3 capitalized words + SUFFIX scores
 * highest; suffix-only or non-leading-numeric variants score lower but still emit.
 */
export function scoreStreetPhrase(tokens: ReadonlyArray<SegmentToken>, text: string): PhraseProposal[] {
	const out: PhraseProposal[] = []
	for (let suffixIdx = 0; suffixIdx < tokens.length; suffixIdx++) {
		if (!isStreetSuffix(tokens[suffixIdx]!.body)) continue
		// Walk left from the suffix gathering capitalized/numeric/ordinal tokens. Stop when we hit
		// something un-street-y (lowercase non-suffix, another suffix, etc.).
		let start = suffixIdx
		for (let i = suffixIdx - 1; i >= 0; i--) {
			const body = tokens[i]!.body
			if (isAllDigit(body) || /^\d+(st|nd|rd|th)$/i.test(body) || startsCapitalized(body)) {
				start = i
			} else {
				break
			}
		}
		// Need at least one preceding token (or a numeric house number) for STREET_PHRASE — a
		// suffix-only token "Street" alone isn't a street phrase.
		if (start === suffixIdx) continue
		const startTok = tokens[start]!
		const endTok = tokens[suffixIdx]!
		const hasLeadingNumeric = isAllDigit(startTok.body) || /^\d+(st|nd|rd|th)$/i.test(startTok.body)
		// Canonical NUMERIC + capitalized + SUFFIX scores high; capitalized-run + SUFFIX scores
		// slightly lower since it could also be a venue.
		const confidence = hasLeadingNumeric ? 0.9 : 0.75
		out.push({
			span: makeSection(text, startTok.start, endTok.end),
			kindHypothesis: "STREET_PHRASE",
			confidence,
		})
	}
	return out
}

/**
 * `LOCALITY_PHRASE` rule: runs of contiguous capitalized words (1-4 long). Emits multiple
 * overlapping proposals so the reconciler can choose between e.g. `Saint Petersburg` as one phrase
 * vs `Saint` + `Petersburg` as two.
 *
 * Confidence scales with: run length (2-3 best), tail-of-segment position, and whether the
 * preceding token is a comma or segment boundary.
 */
export function scoreLocalityPhrase(
	tokens: ReadonlyArray<SegmentToken>,
	text: string,
	segmentIsLast: boolean
): PhraseProposal[] {
	const out: PhraseProposal[] = []
	for (let i = 0; i < tokens.length; i++) {
		if (!startsCapitalized(tokens[i]!.body)) continue
		// Skip pure region abbreviations as standalone LOCALITY_PHRASE — they own REGION_ABBREVIATION
		// at higher confidence.
		if (isRegionAbbreviation(tokens[i]!.body)) continue
		// Walk forward grabbing additional capitalized tokens. Stop on lowercase, digit-only, or
		// region-abbreviation tokens.
		let j = i
		while (
			j + 1 < tokens.length &&
			startsCapitalized(tokens[j + 1]!.body) &&
			!isRegionAbbreviation(tokens[j + 1]!.body) &&
			!isAllDigit(tokens[j + 1]!.body) &&
			!isStreetSuffix(tokens[j + 1]!.body)
		) {
			j++
		}
		// Emit proposals for every prefix-length of the run starting at i, capped at 4 tokens.
		// Each starting i contributes at most 4 proposals, so the rule stays O(n) per segment.
		const maxLen = Math.min(j - i + 1, 4)
		for (let len = 1; len <= maxLen; len++) {
			const startTok = tokens[i]!
			const endTok = tokens[i + len - 1]!
			const spanText = text.slice(startTok.start, endTok.end)
			const isRegionName = len === 1 && US_REGION_NAMES.has(spanText.toLowerCase())
			const atTail = i + len - 1 === tokens.length - 1
			let confidence = 0.55 + (len === 2 ? 0.15 : 0) + (len === 3 ? 0.1 : 0)
			if (isRegionName && !atTail) confidence -= 0.2
			if (atTail && segmentIsLast) confidence += 0.1
			if (atTail) confidence += 0.05
			out.push({
				span: makeSection(text, startTok.start, endTok.end),
				kindHypothesis: "LOCALITY_PHRASE",
				confidence: Math.min(0.95, confidence),
			})
		}
		// Do NOT skip past the run — let i++ advance normally so every capitalized token gets a
		// chance to emit single-token proposals from its own starting position. (Saint Petersburg
		// needs `Saint`, `Petersburg`, AND `Saint Petersburg`; a run-skip would lose `Petersburg`.)
	}
	return out
}

/**
 * `VENUE_PHRASE` rule: capitalized run containing a venue-marker noun (Steakhouse, Hotel, etc.) OR
 * containing a hyphenated compound + ≥1 capitalized word.
 *
 * The shape "NY-NY Steakhouse" — the kryptonite case the reconciler eventually needs to lift the NY
 * tokens off REGION — surfaces here as a `VENUE_PHRASE` proposal at moderate-high confidence.
 *
 * Also includes a venue-by-exclusion positional prior: multi-word capitalized run in the first
 * segment with no street suffix, no house number, and no unit marker → weak VENUE_PHRASE at
 * 0.50-0.55. The idea: if we can't identify what something IS, but it's in the venue slot (first
 * segment) and doesn't look like any other component, it might be a venue name.
 */
export function scoreVenuePhrase(
	tokens: ReadonlyArray<SegmentToken>,
	text: string,
	segmentIsFirst?: boolean
): PhraseProposal[] {
	const out: PhraseProposal[] = []
	let i = 0
	while (i < tokens.length) {
		if (!startsCapitalized(tokens[i]!.body)) {
			i++
			continue
		}
		let j = i
		while (j + 1 < tokens.length && (startsCapitalized(tokens[j + 1]!.body) || tokens[j + 1]!.body.includes("-"))) {
			j++
		}
		const run = tokens.slice(i, j + 1)
		const markerWeight = venueMarkerWeight(run)
		const hasHyphenCompound = run.some((t) => /[^-]-[^-]/.test(t.body))

		if (markerWeight > 0 || (hasHyphenCompound && run.length >= 2)) {
			const startTok = run[0]!
			const endTok = run[run.length - 1]!
			const confidence = markerWeight > 0 ? markerWeight : 0.65
			out.push({
				span: makeSection(text, startTok.start, endTok.end),
				kindHypothesis: "VENUE_PHRASE",
				confidence,
			})
		} else if (segmentIsFirst && run.length >= 2) {
			const hasStreet = run.some((t) => isStreetSuffix(t.body))
			const hasLeadingNum = isAllDigit(run[0]!.body)
			const hasUnit = hasUnitMarker(run)
			if (!hasStreet && !hasLeadingNum && !hasUnit) {
				const startTok = run[0]!
				const endTok = run[run.length - 1]!
				out.push({
					span: makeSection(text, startTok.start, endTok.end),
					kindHypothesis: "VENUE_PHRASE",
					confidence: run.length >= 3 ? 0.55 : 0.5,
				})
			}
		}

		i = j + 1
	}
	return out
}
