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

	for (const seg of segments) {
		if (seg.separator !== "comma") continue

		for (const tok of tokens) {
			if (tok.span.start < seg.span.start || tok.span.end > seg.span.end) continue

			if (tok.class !== "alpha") continue

			if (!REGION_ABBREV_RE.test(tok.span.body)) continue

			hits.push({ start: tok.span.start, span: tok.span.body })
		}
	}

	return hits
}
