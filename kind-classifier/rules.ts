/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Rule-based classifiers for each `QueryKind`. Each rule inspects the normalized input + QueryShape
 *   and returns a confidence score in [0, 1], or 0 if the rule doesn't fire.
 *
 *   Bitter-lesson-safe: only universal structural patterns — no place-name dictionaries. ~1 small
 *   regex set per new locale, not 50K dictionary entries.
 */

import type { NormalizedInputLite, QueryShapeLike } from "./types.js"

/** Landmark vocabulary — phrases that suggest a vague-location description rather than an address. */
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

/** Intersection vocabulary — words that signal "where two streets cross" rather than an address. */
const INTERSECTION_PATTERNS = [
	/\bcorner of\b/i,
	/\bintersection of\b/i,
	/\bat the corner of\b/i,
	// "5th and Main", "Broadway & 42nd"
	/\b\w+(?:st|nd|rd|th|street|ave|avenue|blvd|boulevard|road|rd|lane|ln)?\s+(?:and|&|@)\s+\w+/i,
]

/**
 * `po_box` rule: high-confidence iff QueryShape detected a po_box format hit. Confidence comes
 * directly from the hit; covers all locale variants (US "PO Box 123", FR "BP 42", etc.).
 */
export function scorePoBox(_input: NormalizedInputLite, shape: QueryShapeLike): number {
	const hit = shape.knownFormats.find((f) => f.format === "po_box")
	if (!hit) return 0
	// Boost slightly above the raw hit confidence so po_box wins ties with structured_address when
	// both rules fire on the same input.
	return Math.min(1, hit.confidence + 0.1)
}

/**
 * `intersection` rule: text matches one of the conventional intersection phrasings.
 */
export function scoreIntersection(input: NormalizedInputLite, _shape: QueryShapeLike): number {
	const text = input.normalized
	for (const pattern of INTERSECTION_PATTERNS) {
		if (pattern.test(text)) return 0.85
	}
	return 0
}

/**
 * `landmark` rule: text begins with a landmark-leader phrase. These inputs are not addresses proper
 * — they describe a location relative to another place.
 */
export function scoreLandmark(input: NormalizedInputLite, _shape: QueryShapeLike): number {
	const lc = input.normalized.toLowerCase().trim()
	for (const leader of LANDMARK_LEADERS) {
		if (lc.startsWith(leader + " ") || lc === leader) return 0.9
	}
	return 0
}

/** Known QueryShape format strings that indicate "this token is a postcode". */
const POSTCODE_FORMATS: ReadonlySet<string> = new Set([
	"us_zip",
	"us_zip4",
	"uk_postcode",
	"fr_postcode",
	"de_postcode",
	"ca_postcode",
	"jp_postcode",
])

/**
 * Test whether a format string is a postcode variant. Use the set rather than ad-hoc
 * string-matching to avoid the `us_zip4.endsWith("_zip")` false-negative trap.
 */
export function isPostcodeFormat(format: string): boolean {
	return POSTCODE_FORMATS.has(format)
}

/**
 * `postcode_only` rule: input is short AND has a postcode format hit covering most of it.
 *
 * The "covering most of it" check is what distinguishes `"10118"` (postcode-only) from `"350 5th
 * Ave 10118"` (structured-address with a postcode in it).
 */
export function scorePostcodeOnly(input: NormalizedInputLite, shape: QueryShapeLike): number {
	const len = input.normalized.length
	if (len === 0 || len > 16) return 0
	const postcodeHit = shape.knownFormats.find((f) => isPostcodeFormat(f.format))
	if (!postcodeHit) return 0
	const hitLen = postcodeHit.span.end - postcodeHit.span.start
	// At least 70% of the input must be the postcode for the rule to fire confidently.
	if (hitLen / len < 0.7) return 0
	// Confidence scales with how much of the input is the postcode and how confident the format hit was.
	return Math.min(1, postcodeHit.confidence * (hitLen / len) + 0.1)
}

/**
 * `locality_only` rule: short input, alpha-class, single segment, no format hits.
 *
 * Examples: `"Paris"`, `"NYC NY"`, `"Tokyo"`. Distinguishes from `structured_address` (multiple
 * segments) and `vague` (long or mixed-class).
 */
export function scoreLocalityOnly(input: NormalizedInputLite, shape: QueryShapeLike): number {
	const len = input.normalized.length
	if (len === 0 || len > 30) return 0
	if (shape.characterClass !== "alpha") return 0
	if (shape.knownFormats.length > 0) return 0
	// Locality-only inputs typically have 1-3 segments (e.g. "New York" is 1 segment, "Paris, FR" is 2).
	// We allow up to 2 segments before deciding it's structured.
	const segCount = shape.segments?.length ?? 1
	if (segCount > 2) return 0
	return 0.85
}

/**
 * `structured_address` rule: looks like a real multi-component address. Either has multiple
 * segments or is long and mixed-class.
 */
export function scoreStructuredAddress(input: NormalizedInputLite, shape: QueryShapeLike): number {
	const len = input.normalized.length
	if (len === 0) return 0
	const segCount = shape.segments?.length ?? 1
	// Multi-segment input with mixed character class = high confidence structured.
	if (segCount >= 2 && shape.characterClass === "alphanumeric") return 0.9
	// Single-segment but reasonably long and alphanumeric = moderate confidence.
	if (len >= 15 && shape.characterClass === "alphanumeric") return 0.75
	// Multi-segment but pure-alpha = moderate (could be a multi-word locality).
	if (segCount >= 2) return 0.6
	// Single-segment, short, alphanumeric (e.g. "10118-1234" with no other content) — weak.
	if (len < 15 && shape.characterClass === "alphanumeric") return 0.4
	return 0
}

/**
 * `vague` rule: nothing else fired with high confidence — input is ambiguous.
 *
 * Returns a moderate baseline so `vague` always shows up as an alternative, even when other rules
 * dominate. The coordinator decides whether to trust vague as the primary kind.
 */
export function scoreVague(_input: NormalizedInputLite, _shape: QueryShapeLike): number {
	return 0.3
}
