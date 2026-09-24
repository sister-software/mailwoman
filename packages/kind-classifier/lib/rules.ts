/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Rule-based `QueryKind` scorers using normalized input and QueryShape. They rely on structural patterns, not place-name
 *   dictionaries, and return confidence from 0 to 1.
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
 * Maximum length for a bare postcode with optional country prefix and separators.
 */
const MAX_POSTCODE_ONLY_LENGTH = 16

/**
 * Minimum input fraction occupied by a postcode for `postcode_only`.
 */
const MIN_POSTCODE_COVERAGE = 0.7

/**
 * Maximum length for a bare locality, shared with the `bare_toponym` intent rule.
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
 * Minimum length for a single-segment alphanumeric postcode.
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
 * Score highly when QueryShape detects a PO Box format.
 */
export function scorePoBox(_input: NormalizedInputLite, shape: QueryShapeLike): number {
	const hit = shape.knownFormats.find((f) => f.format === "po_box")

	if (!hit) return 0

	// Prefer PO Box over structured-address on a tie.
	return Math.min(1, hit.confidence + 0.1)
}

/**
 * Score conventional street-intersection phrasing.
 */
export function scoreIntersection(input: NormalizedInputLite, _shape: QueryShapeLike): number {
	const text = input.normalized

	for (const pattern of INTERSECTION_PATTERNS) {
		if (pattern.test(text)) return 0.85
	}

	return 0
}

/**
 * Score inputs that begin with a relative-landmark phrase.
 */
export function scoreLandmark(input: NormalizedInputLite, _shape: QueryShapeLike): number {
	const lc = input.normalized.toLowerCase().trim()

	for (const leader of LANDMARK_LEADERS) {
		if (lc.startsWith(leader + " ") || lc === leader) return 0.9
	}

	return 0
}

/**
 * Split on whitespace and commas, removing empty tokens.
 * Shared with `intent-rules.ts`.
 */
export function wordsOf(text: string): string[] {
	return text.split(/[\s,]+/).filter((word) => word.length)
}

/**
 * Check for an unambiguous USPS street suffix, excluding suffixes also common in place names.
 */
export function isDisqualifyingStreetSuffix(word: string): boolean {
	const canonical = US_STREET_SUFFIX_LOOKUP.get(word.trim().toLowerCase())

	return canonical !== undefined && !NAME_PRONE_US_SUFFIXES.has(canonical)
}

/**
 * Remove postcode spans and normalize leftover separators.
 * Preserve other recognized formats.
 */
export function withoutPostcodeSpans(text: string, shape: QueryShapeLike): string {
	const merged = mergedPostcodeSpans(shape)

	if (!merged.length) return text

	let remainder = text

	// Last-to-first, so an earlier removal cannot move a later span's offsets.
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
 * Check for at least one Unicode letter; an `alpha` class alone may represent punctuation-only input.
 */
export function carriesLetter(text: string): boolean {
	return /\p{L}/u.test(text)
}

/**
 * Merge overlapping postcode hits into sorted, disjoint spans.
 */
function mergedPostcodeSpans(shape: QueryShapeLike): Array<{ start: number; end: number }> {
	// Restrict removal to the final segment to avoid speculative matches on leading house numbers.
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
 * Score short capitalized venue names without street suffixes or postcode hits.
 */
export function scoreVenueLandmark(input: NormalizedInputLite, shape: QueryShapeLike): number {
	const text = input.normalized.trim()
	const len = text.length

	if (len === 0 || len > MAX_LANDMARK_LENGTH) return 0

	// Require a capitalized word.
	if (!/[A-Z]/.test(text)) return 0

	// Reject postcode-like input.
	if (shape.knownFormats.length) return 0

	// Reject multi-segment address shapes.
	const segCount = shape.segments?.length ?? 1

	if (segCount > 2) return 0

	// Reject unambiguous street suffixes.
	const words = wordsOf(text)

	for (const w of words) {
		if (isDisqualifyingStreetSuffix(w)) return 0
	}

	// Reject house-number-leading input.
	if (/^\d+\s/.test(text)) return 0

	// Numbers after the first token are common in venue names.
	const hasInternalNumber = /\s\d+/.test(text) && !/^\d/.test(text)

	// Check for proper-case words.
	const allProperCase = words.length > 1 && words.every((w) => /^[A-Z]/.test(w))

	// Score short, capitalized, single-segment phrases.
	const wordCount = words.length

	if (wordCount >= VENUE_PHRASE_MIN_WORDS && wordCount <= VENUE_PHRASE_MAX_WORDS && segCount === 1) {
		if (hasInternalNumber) return 0.88

		if (allProperCase) return 0.88

		return 0.65
	}

	// Give longer proper-case phrases a moderate score.
	if (wordCount <= LONG_VENUE_PHRASE_MAX_WORDS && segCount === 1 && allProperCase) {
		return 0.75
	}

	return 0
}

/**
 * Score short inputs where a postcode format covers most of the text.
 */
export function scorePostcodeOnly(input: NormalizedInputLite, shape: QueryShapeLike): number {
	const len = input.normalized.length

	if (len === 0 || len > MAX_POSTCODE_ONLY_LENGTH) return 0
	const postcodeHit = shape.knownFormats.find((f) => isPostcodeFormat(f.format))

	if (!postcodeHit) return 0
	const hitLen = postcodeHit.span.end - postcodeHit.span.start

	// Require the postcode to cover most of the input.
	if (hitLen / len < MIN_POSTCODE_COVERAGE) return 0

	// Scale by coverage and format confidence.
	return Math.min(1, postcodeHit.confidence * (hitLen / len) + 0.1)
}

/**
 * Score place names with at most an administrative tail and no street material.
 * Ignore postcode spans when assessing the remaining text.
 */
export function scoreLocalityOnly(input: NormalizedInputLite, shape: QueryShapeLike): number {
	// Other recognized formats indicate additional structure.
	let carriesPostcode = false

	for (const hit of shape.knownFormats) {
		if (isPostcodeFormat(hit.format)) {
			carriesPostcode = true

			continue
		}

		return 0
	}

	// Require postcode hits to be removable from the final segment.
	const removable = carriesPostcode ? mergedPostcodeSpans(shape) : []

	if (carriesPostcode && !removable.length) return 0

	const withoutPostcode = carriesPostcode ? withoutPostcodeSpans(input.normalized, shape) : input.normalized
	const len = withoutPostcode.length

	if (len === 0 || len > MAX_LOCALITY_ONLY_LENGTH) return 0

	if (!carriesLetter(withoutPostcode)) return 0

	// The remaining text must be alphabetic.
	// Recompute its class only when removing a postcode changed the input.
	if (shape.characterClass !== "alpha") {
		if (!carriesPostcode) return 0

		if (foldInputClass(classifyTokens(withoutPostcode)) !== "alpha") return 0
	}

	// Allow at most two segments for a locality and administrative tail.
	const segCount = shape.segments?.length ?? 1

	if (segCount > 2) return 0

	return 0.85
}

/**
 * Score multi-component address shapes.
 */
export function scoreStructuredAddress(input: NormalizedInputLite, shape: QueryShapeLike): number {
	const len = input.normalized.length

	if (len === 0) return 0
	const segCount = shape.segments?.length ?? 1

	// Require non-postcode digits so a postcode alone does not make an admin tail structured.
	if (
		segCount >= 2 &&
		shape.characterClass === "alphanumeric" &&
		/\d/u.test(withoutPostcodeSpans(input.normalized, shape))
	) {
		return 0.9
	}

	// Long, single-segment alphanumeric input gets a moderate score.
	if (len >= ALPHANUMERIC_POSTCODE_MIN_LENGTH && shape.characterClass === "alphanumeric") return 0.75

	// Multi-segment alphabetic input may be a multi-word locality.
	if (segCount >= 2) return 0.6

	// Short, single-segment alphanumeric input gets a weak score.
	if (len < ALPHANUMERIC_POSTCODE_MIN_LENGTH && shape.characterClass === "alphanumeric") return 0.4

	return 0
}

/**
 * Return a moderate fallback score for ambiguous inputs.
 */
export function scoreVague(_input: NormalizedInputLite, _shape: QueryShapeLike): number {
	return 0.3
}
