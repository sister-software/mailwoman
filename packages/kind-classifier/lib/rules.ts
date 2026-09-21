/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Rule-based classifiers for each `QueryKind`. Each rule inspects the normalized input + QueryShape
 *   and returns a confidence score in [0, 1], or 0 if the rule doesn't fire.
 *
 *   Bitter-lesson-safe: only universal structural patterns — no place-name dictionaries. ~1 small
 *   regex set per new locale rather than 50K dictionary entries.
 */

import { NAME_PRONE_US_SUFFIXES, US_STREET_SUFFIX_LOOKUP } from "@mailwoman/codex/us/street-suffix"
import type { NormalizedInputLite, QueryShapeSegmentsView as QueryShapeLike } from "@mailwoman/query-shape"
import { classifyTokens, foldInputClass } from "@mailwoman/query-shape/character-class"
import { isPostcodeFormat } from "@mailwoman/query-shape/known-formats"
/**
 * Longest input still plausible as a bare venue or landmark name.
 *
 * Beyond it the query is carrying an address as well, and belongs to the structured-address scorer.
 */
const MAX_LANDMARK_LENGTH = 50

/**
 * Longest input still plausible as a bare postcode, allowing for a country prefix and separators.
 */
const MAX_POSTCODE_ONLY_LENGTH = 16

/**
 * Share of the input the postcode must occupy before `postcode_only` fires.
 *
 * Below it the query is carrying something else too — a locality, a street — and another kind should win.
 */
const MIN_POSTCODE_COVERAGE = 0.7

/**
 * Longest input still plausible as a bare locality name, including a trailing region code.
 *
 * Exported so `intent-rules.ts`'s `bare_toponym` can share the exact same ceiling.
 * Sharing it is what makes "bare_toponym is a strict refinement of locality_only" a
 * structural property rather than two numbers that happen to agree today.
 */
export const MAX_LOCALITY_ONLY_LENGTH = 30

/**
 * Word count of a short capitalized phrase — the shape of a venue name like `Empire State Building`.
 *
 * Wider than this and the phrase is more likely a full address line.
 */
const VENUE_PHRASE_MIN_WORDS = 2

/**
 * Upper bound of the short-phrase venue window. see {@link VENUE_PHRASE_MIN_WORDS}.
 */
const VENUE_PHRASE_MAX_WORDS = 4

/**
 * Word count above which a single-segment proper-case phrase stops reading as a venue name.
 */
const LONG_VENUE_PHRASE_MAX_WORDS = 6

/**
 * Length at which a single-segment alphanumeric input reads as a full postcode rather than a fragment.
 *
 * Shorter alphanumeric inputs score lower because they are as likely to be a unit number.
 */
const ALPHANUMERIC_POSTCODE_MIN_LENGTH = 15

/**
 * Landmark vocabulary — phrases that suggest a vague-location description rather than an address.
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
 * Intersection vocabulary — words that signal "where two streets cross" rather than an address.
 */
const INTERSECTION_PATTERNS = [
	/\bcorner of\b/i,
	/\bintersection of\b/i,
	/\bat the corner of\b/i,
	// "5th and Main", "Broadway & 42nd"
	/\b\w+(?:st|nd|rd|th|street|ave|avenue|blvd|boulevard|road|rd|lane|ln)?\s+(?:and|&|@)\s+\w+/i,
]

/**
 * `po_box` rule: high-confidence iff QueryShape detected a po_box format hit.
 *
 * Confidence comes directly from the hit. covers all locale variants (US "PO Box 123", FR "BP 42", etc.).
 */
export function scorePoBox(_input: NormalizedInputLite, shape: QueryShapeLike): number {
	const hit = shape.knownFormats.find((f) => f.format === "po_box")

	if (!hit) return 0

	// Boost slightly above the raw hit confidence so po_box wins ties with structured_address
	// when both rules fire on the same input.
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
 * `landmark` rule: text begins with a landmark-leader phrase.
 *
 * These inputs are not addresses proper — they describe a location relative to another place.
 */
export function scoreLandmark(input: NormalizedInputLite, _shape: QueryShapeLike): number {
	const lc = input.normalized.toLowerCase().trim()

	for (const leader of LANDMARK_LEADERS) {
		if (lc.startsWith(leader + " ") || lc === leader) return 0.9
	}

	return 0
}

/**
 * Split on whitespace + commas and drop empty words — the word grammar shared with `intent-rules.ts`.
 *
 * Dropping empties matters: a trailing comma or doubled separator otherwise yields an empty string
 * that inflates the word count and falsifies every-word predicates like the proper-case check below.
 */
export function wordsOf(text: string): string[] {
	return text.split(/[\s,]+/).filter((word) => word.length)
}

/**
 * True when a word is USPS street-suffix vocabulary that unambiguously signals
 * an address — the full Pub-28 table via `@mailwoman/codex`, minus its curated
 * name-prone canonicals (park, field, hill, lake, …).
 *
 * Those double as ordinary proper-name heads ("Wrigley Field", "Menlo Park"), and disqualifying
 * on them would reject the very venue and place names the rules below exist to capture.
 * Shared with `intent-rules.ts` so both rule sets read one definition.
 */
export function isDisqualifyingStreetSuffix(word: string): boolean {
	const canonical = US_STREET_SUFFIX_LOOKUP.get(word.trim().toLowerCase())

	return canonical !== undefined && !NAME_PRONE_US_SUFFIXES.has(canonical)
}

/**
 * The input with every postcode span removed, and the separators the removal orphaned collapsed away.
 *
 * A postcode is the one digit run that carries no information about whether the query names a street.
 * Read over `Thomas, WV 26292` the whole-input character class is `alphanumeric` and the shape reports
 * a known-format hit, and both readings describe the postcode rather than the name in front of it.
 *
 * Read over what this returns — `Thomas, WV` — the class is `alpha`, which is the
 * question the locality rules mean to ask (#2342).
 *
 * Non-postcode formats are left in place: they are evidence of some other structure,
 * and removing them would hide it.
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
 * True when the text carries at least one letter in any script.
 *
 * The rules that admit a place name read `characterClass === "alpha"` to mean "no address grammar",
 * and that reading is silent about whether any name is present: `foldInputClass` answers
 * `alpha` for input carrying no classified token at all, so `"???"` and `""` both read alpha.
 * A name has to be asserted rather than inferred from the class.
 */
export function carriesLetter(text: string): boolean {
	return /\p{L}/u.test(text)
}

/**
 * The postcode hits as disjoint intervals, ascending, or an empty array when the shape reports none.
 *
 * One digit run matches several postcode formats at the same offsets — `26292` is a us_zip,
 * an fr_postcode and a de_postcode — so the hits must merge before any text is removed.
 * Removing each hit separately deletes the same span once per format and shifts everything
 * after it, which returned `V` for `26292 Thomas, WV`.
 *
 * This runs on every classify, so it allocates nothing until a postcode hit exists.
 */
function mergedPostcodeSpans(shape: QueryShapeLike): Array<{ start: number; end: number }> {
	// Only a hit inside the last segment counts.
	// The detectors are speculative and multi-country, so a leading house number attracts
	// one: `3215 SE Clinton St, Portland OR` reports `3215 SE` as an nl_postcode,
	// and removing that leaves `Clinton St, Portland OR`, which reads alpha
	// and turns a full street address into a locality query.
	// An admin tail carries its postcode in its last segment, which is the property that separates the two.
	//
	// A shape stating no segment spans gets no removal, which is the reading these rules had before #2342.
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
 * `landmark` rule (venue/named-place variant): short capitalized input with no street
 * suffixes, no postcode hits, and no region abbreviations.
 *
 * Captures "Pier 39", "Empire State Building", "Wrigley Field", "Grand Central Terminal".
 *
 * Fires at moderate confidence (0.65) — below structured_address (0.9) so addresses always win,
 * but above vague (0.3) so the pipeline can route landmark queries to the venue resolver.
 */
export function scoreVenueLandmark(input: NormalizedInputLite, shape: QueryShapeLike): number {
	const text = input.normalized.trim()
	const len = text.length

	if (len === 0 || len > MAX_LANDMARK_LENGTH) return 0

	// Must have at least one capitalized word.
	if (!/[A-Z]/.test(text)) return 0

	// Reject if any known postcode format hit exists.
	if (shape.knownFormats.length) return 0

	// Reject if it looks like a multi-segment structured address (City, ST ZIP).
	const segCount = shape.segments?.length ?? 1

	if (segCount > 2) return 0

	// Reject if any word is an unambiguous street suffix.
	const words = wordsOf(text)

	for (const w of words) {
		if (isDisqualifyingStreetSuffix(w)) return 0
	}

	// Reject if the first token is a pure number (house-number-leading pattern).
	if (/^\d+\s/.test(text)) return 0

	// Boost if the input has a number that is not at the start (venue-style: "Pier 39", "Terminal 5").
	const hasInternalNumber = /\s\d+/.test(text) && !/^\d/.test(text)

	// Check if every word starts with uppercase (proper-noun pattern).
	const allProperCase = words.length > 1 && words.every((w) => /^[A-Z]/.test(w))

	// Boost for short single-segment capitalized phrases (2-4 words).
	const wordCount = words.length

	if (wordCount >= VENUE_PHRASE_MIN_WORDS && wordCount <= VENUE_PHRASE_MAX_WORDS && segCount === 1) {
		if (hasInternalNumber) return 0.88

		if (allProperCase) return 0.88

		return 0.65
	}

	// Longer single-segment capitalized phrases get moderate confidence.
	if (wordCount <= LONG_VENUE_PHRASE_MAX_WORDS && segCount === 1 && allProperCase) {
		return 0.75
	}

	return 0
}

/**
 * `postcode_only` rule: input is short and has a postcode format hit covering most of it.
 *
 * The "covering most of it" check is what distinguishes `"10118"` (postcode-only) from
 * `"350 5th Ave 10118"` (structured-address with a postcode in it).
 */
export function scorePostcodeOnly(input: NormalizedInputLite, shape: QueryShapeLike): number {
	const len = input.normalized.length

	if (len === 0 || len > MAX_POSTCODE_ONLY_LENGTH) return 0
	const postcodeHit = shape.knownFormats.find((f) => isPostcodeFormat(f.format))

	if (!postcodeHit) return 0
	const hitLen = postcodeHit.span.end - postcodeHit.span.start

	// At least 70% of the input must be the postcode for the rule to fire confidently.
	if (hitLen / len < MIN_POSTCODE_COVERAGE) return 0

	// Confidence scales with how much of the input is the postcode and how confident the format hit was.
	return Math.min(1, postcodeHit.confidence * (hitLen / len) + 0.1)
}

/**
 * `locality_only` rule: a place name and at most an admin tail, with no street material.
 *
 * Examples: `"Paris"`, `"NYC NY"`, `"Tokyo"`, `"Thomas, WV 26292"`.
 * Distinguishes from `structured_address` (carries a house number, or more segments
 * than an admin tail needs) and `vague` (long or mixed-class).
 *
 * Every test below reads the input with its postcode spans removed. Reading the whole input instead made a postcode
 * decide the verdict: it flips the character class to `alphanumeric` and registers a known-format hit, so `Thomas, WV
 * 26292` scored 0 here while `Thomas, WV` scored 0.85, and the two differ by nothing that bears on whether a street is
 * present. That verdict chooses the parse register, and the register decides whether the decoder is fed the lexicons
 * that separate a place name from a street name (#2342).
 */
export function scoreLocalityOnly(input: NormalizedInputLite, shape: QueryShapeLike): number {
	// A non-postcode format hit is evidence of some other structure, and nothing removes it.
	let carriesPostcode = false

	for (const hit of shape.knownFormats) {
		if (isPostcodeFormat(hit.format)) {
			carriesPostcode = true

			continue
		}

		return 0
	}

	// A postcode this rule cannot place in the last segment is a format hit like any other,
	// so it rejects — the reading this rule had before #2342.
	// Treating it as absent instead would admit an input whose postcode sits wherever the
	// detector found it, which is what the last-segment restriction exists to refuse.
	const removable = carriesPostcode ? mergedPostcodeSpans(shape) : []

	if (carriesPostcode && !removable.length) return 0

	const withoutPostcode = carriesPostcode ? withoutPostcodeSpans(input.normalized, shape) : input.normalized
	const len = withoutPostcode.length

	if (len === 0 || len > MAX_LOCALITY_ONLY_LENGTH) return 0

	if (!carriesLetter(withoutPostcode)) return 0

	// The remainder must fold to `alpha`.
	// Two readings answer that without re-tokenizing, and this rule runs on every classify,
	// so it reaches the fold only when neither shortcut applies:
	//
	// - An input the shape already calls `alpha` stays alpha once characters are removed from it.
	// - An input carrying no postcode has an empty remainder-to-input difference,
	//   so the shape's own class is the answer, which is what this rule read before #2342.
	//
	// Otherwise the fold runs on the remainder through the same function `computeQueryShape`
	// uses, which is what keeps the two readings from drifting apart.
	// A house number leaves digits in the remainder, so this test also rejects
	// every street-led input: the remainder of `153 Holloway Rd, London N7 8LX` is
	// `153 Holloway Rd London`, which folds to alphanumeric.
	// A separate leading-digit test would be unreachable here, and applied to the raw input it would
	// reject `26292 Thomas, WV`, whose leading digits are the postcode rather than a house number.
	if (shape.characterClass !== "alpha") {
		if (!carriesPostcode) return 0

		if (foldInputClass(classifyTokens(withoutPostcode)) !== "alpha") return 0
	}

	// Locality-only inputs typically have 1-3 segments (e.g. "New York" is 1 segment, "Paris, FR" is 2).
	// We allow up to 2 segments before deciding it's structured.
	const segCount = shape.segments?.length ?? 1

	if (segCount > 2) return 0

	return 0.85
}

/**
 * `structured_address` rule: looks like a real multi-component address.
 *
 * Either has multiple segments or is long and mixed-class.
 */
export function scoreStructuredAddress(input: NormalizedInputLite, shape: QueryShapeLike): number {
	const len = input.normalized.length

	if (len === 0) return 0
	const segCount = shape.segments?.length ?? 1

	// Multi-segment input with mixed character class = high confidence structured.
	//
	// The branch additionally requires digits that survive removing the postcode —
	// a house number, a unit, a numbered street.
	// A postcode alone is not evidence of street material, so an admin tail must not reach 0.9 on the
	// strength of it: without that test the branch returns 0.9 for `Thomas, WV 26292`, which outranks
	// `locality_only`'s 0.85 and leaves the change in `scoreLocalityOnly` with no effect (#2342).
	// The remainder is built only here, because the other branches never consult it
	// and this rule runs on every classify.
	if (
		segCount >= 2 &&
		shape.characterClass === "alphanumeric" &&
		/\d/u.test(withoutPostcodeSpans(input.normalized, shape))
	) {
		return 0.9
	}

	// Single-segment but reasonably long and alphanumeric = moderate confidence.
	if (len >= ALPHANUMERIC_POSTCODE_MIN_LENGTH && shape.characterClass === "alphanumeric") return 0.75

	// Multi-segment but pure-alpha = moderate (could be a multi-word locality).
	if (segCount >= 2) return 0.6

	// Single-segment, short, alphanumeric (e.g. "10118-1234" with no other content) — weak.
	if (len < ALPHANUMERIC_POSTCODE_MIN_LENGTH && shape.characterClass === "alphanumeric") return 0.4

	return 0
}

/**
 * `vague` rule: nothing else fired with high confidence — input is ambiguous.
 *
 * Returns a moderate baseline so `vague` always shows up as an alternative, even when other rules dominate.
 * The coordinator decides whether to trust vague as the primary kind.
 */
export function scoreVague(_input: NormalizedInputLite, _shape: QueryShapeLike): number {
	return 0.3
}
