/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Detect unambiguous region abbreviations (e.g., "DC", "NY", "CA") for the locality soft prior.
 *   Only fires after a comma-space boundary in en-us — the canonical "City, ST ZIP" pattern.
 */

import type { RegionAbbreviationHit, Segment, TokenClass } from "./types.ts"

const REGION_ABBREV_RE = /^[A-Z]{2}$/

/**
 * Find region abbreviation hits. A hit is a 2-letter all-uppercase token that appears after a comma-separated segment
 * boundary — the canonical "City, ST" or "City, ST ZIP" tail pattern.
 *
 * Returns empty array for non-Western locales or inputs without comma segmentation.
 */
export function detectRegionAbbreviations(
	tokens: ReadonlyArray<TokenClass>,
	segments: ReadonlyArray<Segment>
): RegionAbbreviationHit[] {
	if (segments.length < 2) return []

	const hits: RegionAbbreviationHit[] = []

	// Single pass over both arrays, relying on two properties of the caller's output: `tokens` and
	// `segments` are each sorted by `span.start`, and segments do not overlap. Pairing them with a nested
	// scan is quadratic in input LENGTH, since both grow with it, and this runs on every parse.
	let t = 0

	for (const seg of segments) {
		// Advance on EVERY segment, not just the comma ones below. A non-comma segment between two comma
		// segments still contains tokens; leaving the pointer behind it desyncs the walk.
		while (t < tokens.length && tokens[t]!.span.start < seg.span.start) {
			t++
		}

		if (seg.separator !== "comma") continue

		// `k` rather than `t`: a token belongs to one segment, but the outer loop needs the pointer parked
		// at this segment's first token so the next iteration resumes in the right place.
		for (let k = t; k < tokens.length && tokens[k]!.span.end <= seg.span.end; k++) {
			const tok = tokens[k]!

			if (tok.class !== "alpha") continue

			if (!REGION_ABBREV_RE.test(tok.span.body)) continue

			hits.push({ start: tok.span.start, span: tok.span.body })
		}
	}

	return hits
}
