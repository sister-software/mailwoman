/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Rule-based `QueryKind` scorers. Each scorer reads structural patterns in the normalized input and
 *   its QueryShape and returns a confidence from 0 to 1.
 */

import { NAME_PRONE_US_SUFFIXES, US_STREET_SUFFIX_LOOKUP } from "@mailwoman/codex/us/street-suffix"
import type { NormalizedInputLite, QueryShapeSegmentsView as QueryShapeLike } from "@mailwoman/query-shape"
import { classifyTokens, foldInputClass } from "@mailwoman/query-shape/character-class"
import { isPostcodeFormat } from "@mailwoman/query-shape/known-formats"
/**
 * Maximum length for a bare venue or landmark query.
 */
const MAX_LANDMARK_LENGTH = 50

/**
 * Maximum length for a bare postcode, including an optional country prefix and separators.
 */
const MAX_POSTCODE_ONLY_LENGTH = 16

/**
 * Minimum fraction of the input that a postcode must cover for `postcode_only`.
 */
const MIN_POSTCODE_COVERAGE = 0.7

/**
 * Maximum length for a bare locality.
 * The `bare_toponym` intent rule uses the same limit.
 */
export const MAX_LOCALITY_ONLY_LENGTH = 30

/**
 * Minimum word count for a short venue phrase.
 */
const VENUE_PHRASE_MIN_WORDS = 2

/**
 * Maximum word count for a short venue phrase.
 */
const VENUE_PHRASE_MAX_WORDS = 4

/**
 * Maximum word count for a longer single-segment venue phrase.
 */
const LONG_VENUE_PHRASE_MAX_WORDS = 6

/**
 * Length at which single-segment alphanumeric input scores as a likely structured address.
 */
const ALPHANUMERIC_POSTCODE_MIN_LENGTH = 15

/**
 * Phrases that signal a relative landmark description.
 */
const LANDMARK_LEADERS = [
	"behind",
	"near",
	"across from",
	"opposite",
	"next to",
	"by the",
	"in front of",
	"close to",
	"beside",
]

/**
 * Patterns that signal a street intersection.
 */
const INTERSECTION_PATTERNS = [
	/\bcorner of\b/i,
	/\bintersection of\b/i,
	/\bat the corner of\b/i,
	// Examples: "5th and Main", "Broadway & 42nd".
	/\b\w+(?:st|nd|rd|th|street|ave|avenue|blvd|boulevard|road|rd|lane|ln)?\s+(?:and|&|@)\s+\w+/i,
]

/**
 * Scores input in which QueryShape detected a PO Box format.
 */
export function scorePoBox(_input: NormalizedInputLite, shape: QueryShapeLike): number {
	const hit = shape.knownFormats.find((f) => f.format === "po_box")

	if (!hit) return 0

	// The bonus makes a PO Box win a tie with a structured address.
	return Math.min(1, hit.confidence + 0.1)
}

/**
 * Scores street-intersection phrasing.
 */
export function scoreIntersection(input: NormalizedInputLite, _shape: QueryShapeLike): number {
	const text = input.normalized

	for (const pattern of INTERSECTION_PATTERNS) {
		if (pattern.test(text)) return 0.85
	}

	return 0
}

/**
 * Scores input that begins with a relative-landmark phrase.
 */
export function scoreLandmark(input: NormalizedInputLite, _shape: QueryShapeLike): number {
	const lc = input.normalized.toLowerCase().trim()

	for (const leader of LANDMARK_LEADERS) {
		if (lc.startsWith(leader + " ") || lc === leader) return 0.9
	}

	return 0
}

/**
 * Splits text on whitespace and commas and drops empty tokens.
 */
export function wordsOf(text: string): string[] {
	return text.split(/[\s,]+/).filter((word) => word.length)
}

/**
 * Reports whether a word is a USPS street suffix that rarely appears in place names.
 */
export function isDisqualifyingStreetSuffix(word: string): boolean {
	const canonical = US_STREET_SUFFIX_LOOKUP.get(word.trim().toLowerCase())

	return canonical !== undefined && !NAME_PRONE_US_SUFFIXES.has(canonical)
}

/**
 * Removes postcode spans in the final segment and collapses the remaining separators.
 */
export function withoutPostcodeSpans(text: string, shape: QueryShapeLike): string {
	const merged = mergedPostcodeSpans(shape)

	if (!merged.length) return text

	let remainder = text

	// Removing spans from last to first keeps the remaining offsets valid.
	for (let index = merged.length - 1; index >= 0; index--) {
		const span = merged[index]!

		remainder = remainder.slice(0, span.start) + remainder.slice(span.end)
	}

	return remainder
		.replaceAll(/[\s,]+/gu, " ")
		.replace(/[\s,]+$/u, "")
		.trim()
}

/**
 * Reports whether text contains a Unicode letter.
 *
 * The `alpha` character class alone can match punctuation-only input.
 */
export function carriesLetter(text: string): boolean {
	return /\p{L}/u.test(text)
}

/**
 * Merges overlapping postcode hits in the final segment into sorted, disjoint spans.
 */
function mergedPostcodeSpans(shape: QueryShapeLike): Array<{ start: number; end: number }> {
	// Postcode hits in earlier segments are often house numbers.
	const tail = shape.segments?.at(-1)?.span

	if (!tail) return []

	const merged: Array<{ start: number; end: number }> = []

	for (const hit of shape.knownFormats) {
		if (!isPostcodeFormat(hit.format)) continue

		if (hit.span.start < tail.start || hit.span.end > tail.end) continue

		merged.push({ start: hit.span.start, end: hit.span.end })
	}

	if (merged.length < 2) return merged

	merged.sort((left, right) => left.start - right.start)

	const disjoint: Array<{ start: number; end: number }> = [merged[0]!]

	for (const span of merged.slice(1)) {
		const last = disjoint.at(-1)!

		if (span.start <= last.end) {
			last.end = Math.max(last.end, span.end)

			continue
		}

		disjoint.push(span)
	}

	return disjoint
}

/**
 * Scores short capitalized venue names that have no street suffix or recognized format.
 */
export function scoreVenueLandmark(input: NormalizedInputLite, shape: QueryShapeLike): number {
	const text = input.normalized.trim()
	const len = text.length

	if (len === 0 || len > MAX_LANDMARK_LENGTH) return 0

	if (!/[A-Z]/.test(text)) return 0

	if (shape.knownFormats.length) return 0

	const segCount = shape.segments?.length ?? 1

	if (segCount > 2) return 0

	const words = wordsOf(text)

	for (const w of words) {
		if (isDisqualifyingStreetSuffix(w)) return 0
	}

	// A leading number usually is a house number.
	if (/^\d+\s/.test(text)) return 0

	// Venue names often contain a number after the first word.
	const hasInternalNumber = /\s\d+/.test(text) && !/^\d/.test(text)

	const allProperCase = words.length > 1 && words.every((w) => /^[A-Z]/.test(w))

	const wordCount = words.length

	if (wordCount >= VENUE_PHRASE_MIN_WORDS && wordCount <= VENUE_PHRASE_MAX_WORDS && segCount === 1) {
		if (hasInternalNumber) return 0.88

		if (allProperCase) return 0.88

		return 0.65
	}

	if (wordCount <= LONG_VENUE_PHRASE_MAX_WORDS && segCount === 1 && allProperCase) {
		return 0.75
	}

	return 0
}

/**
 * Scores short input in which a postcode covers most of the text.
 */
export function scorePostcodeOnly(input: NormalizedInputLite, shape: QueryShapeLike): number {
	const len = input.normalized.length

	if (len === 0 || len > MAX_POSTCODE_ONLY_LENGTH) return 0
	const postcodeHit = shape.knownFormats.find((f) => isPostcodeFormat(f.format))

	if (!postcodeHit) return 0
	const hitLen = postcodeHit.span.end - postcodeHit.span.start

	if (hitLen / len < MIN_POSTCODE_COVERAGE) return 0

	return Math.min(1, postcodeHit.confidence * (hitLen / len) + 0.1)
}

/**
 * Scores a place name with at most an administrative tail and an optional postcode.
 */
export function scoreLocalityOnly(input: NormalizedInputLite, shape: QueryShapeLike): number {
	// Any recognized format other than a postcode rules out a bare locality.
	let carriesPostcode = false

	for (const hit of shape.knownFormats) {
		if (isPostcodeFormat(hit.format)) {
			carriesPostcode = true

			continue
		}

		return 0
	}

	// Only postcode hits in the final segment can be removed.
	const removable = carriesPostcode ? mergedPostcodeSpans(shape) : []

	if (carriesPostcode && !removable.length) return 0

	const withoutPostcode = carriesPostcode ? withoutPostcodeSpans(input.normalized, shape) : input.normalized
	const len = withoutPostcode.length

	if (len === 0 || len > MAX_LOCALITY_ONLY_LENGTH) return 0

	if (!carriesLetter(withoutPostcode)) return 0

	// The remaining text must be alphabetic.
	// Its class is recomputed only after a postcode was removed.
	if (shape.characterClass !== "alpha") {
		if (!carriesPostcode) return 0

		if (foldInputClass(classifyTokens(withoutPostcode)) !== "alpha") return 0
	}

	// A locality and an administrative tail use at most two segments.
	const segCount = shape.segments?.length ?? 1

	if (segCount > 2) return 0

	return 0.85
}

/**
 * Scores multi-component address shapes.
 */
export function scoreStructuredAddress(input: NormalizedInputLite, shape: QueryShapeLike): number {
	const len = input.normalized.length

	if (len === 0) return 0
	const segCount = shape.segments?.length ?? 1

	// Digits outside the postcode are required, so a locality with a postcode does not score here.
	if (
		segCount >= 2 &&
		shape.characterClass === "alphanumeric" &&
		/\d/u.test(withoutPostcodeSpans(input.normalized, shape))
	) {
		return 0.9
	}

	if (len >= ALPHANUMERIC_POSTCODE_MIN_LENGTH && shape.characterClass === "alphanumeric") return 0.75

	// Multi-segment input without digits may still be a multi-word locality, so it scores lower.
	if (segCount >= 2) return 0.6

	if (len < ALPHANUMERIC_POSTCODE_MIN_LENGTH && shape.characterClass === "alphanumeric") return 0.4

	return 0
}

/**
 * Returns a low constant fallback score for ambiguous input.
 */
export function scoreVague(_input: NormalizedInputLite, _shape: QueryShapeLike): number {
	return 0.3
}
