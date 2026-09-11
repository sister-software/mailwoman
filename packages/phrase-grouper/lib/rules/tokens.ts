/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @file Phrase-grouping token spans.
 */

import { US_STATE_NAMES } from "@mailwoman/codex/us/state"
import { Span } from "@mailwoman/core/tokenization"

/**
 * One token within a segment — absolute offsets into the normalized input. Built by `tokenizeSegment` from a
 * (segment-text, segment-start) pair.
 */
export interface SegmentToken {
	body: string
	start: number
	end: number
}

const WHITESPACE = /\s+/

/**
 * Neutral baseline confidence for phrase proposals when no structural cue (position, length, known
 * suffix/prefix/marker, format-hit) lifts or penalizes the score. Each rule adds bonuses on top of this base (e.g.
 * +0.15 for 2-token locality runs, +0.1 for tail-of-last-segment) and subtracts penalties (e.g. −0.2 for a known US
 * region name that isn't at segment-tail).
 */
export const NEUTRAL_PROPOSAL_CONFIDENCE = 0.55

/**
 * Single-token US state/territory names, derived from the codex roster. SINGLE-TOKEN scope on purpose: the non-tail
 * region-name penalty below reads one token at a time, and a multi-word name ("New York", "North Carolina") can never
 * match a single token — deriving only the single-token names keeps the set equal to what the check can ever see.
 */
export const US_REGION_NAMES: ReadonlySet<string> = new Set(
	US_STATE_NAMES.filter((name) => !name.includes(" ")).map((name) => name.toLowerCase())
)

/**
 * Split a segment body into whitespace-separated tokens. Offsets are absolute into the original input (caller supplies
 * the segment's `start` offset). Deliberately NOT `@mailwoman/query-shape`'s tokenizer: that one yields code-point
 * CLASS runs for the whole input, while this one carries segment-relative → absolute span math for the proposal spans —
 * the two disagree on what a token boundary is.
 */
/**
 * Digit count above which a pure-numeric token stops being unambiguously a house number. 1-4 digits are clearly
 * NUMERIC; 5 and up collide with postcodes, so the proposal is emitted at neutral confidence and the reconciler
 * decides.
 */
export const MAX_UNAMBIGUOUS_HOUSE_NUMBER_DIGITS = 4

/**
 * Confidence for a pure-numeric token short enough to be unambiguous.
 */
export const UNAMBIGUOUS_NUMERIC_CONFIDENCE = 0.95

/**
 * Token count at which a run reads as a venue name in its own right rather than a stray pair.
 */
export const VENUE_RUN_MIN_TOKENS = 3

/**
 * Confidence for a venue run too short to clear {@link VENUE_RUN_MIN_TOKENS}.
 */
export const SHORT_VENUE_RUN_CONFIDENCE = 0.5

/**
 * Confidence added to a place-name run by its token count. Longer runs are less likely to be a coincidental adjacency,
 * so they earn more — the curve flattens past four tokens.
 */
export const PLACE_RUN_LENGTH_BONUS: ReadonlyMap<number, number> = new Map([
	[2, 0.15],
	[3, 0.12],
])

/**
 * Bonus applied to place-name runs at or beyond {@link VENUE_RUN_MIN_TOKENS} + 1 tokens.
 */
export const LONG_PLACE_RUN_BONUS = 0.08

/**
 * Penalty for a US region NAME appearing away from the tail, where it is more likely a locality.
 */
export const NON_TAIL_REGION_NAME_PENALTY = 0.2

export function tokenizeSegment(segmentBody: string, segmentStart: number): SegmentToken[] {
	const tokens: SegmentToken[] = []
	let i = 0

	while (i < segmentBody.length) {
		while (i < segmentBody.length && WHITESPACE.test(segmentBody[i]!)) {
			i++
		}

		if (i >= segmentBody.length) break
		const start = i

		while (i < segmentBody.length && !WHITESPACE.test(segmentBody[i]!)) {
			i++
		}

		tokens.push({
			body: segmentBody.slice(start, i),
			start: segmentStart + start,
			end: segmentStart + i,
		})
	}

	return tokens
}

/**
 * Build a `Section` (Span instance) from absolute offsets into the original text.
 */
export function makeSection(text: string, start: number, end: number): Span {
	return Span.from(text.slice(start, end), { start })
}

/**
 * True when token body is non-empty digits only.
 */
export function isAllDigit(s: string): boolean {
	return s.length > 0 && /^[0-9]+$/.test(s)
}
