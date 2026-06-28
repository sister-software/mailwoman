/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `groupPhrases` — Stage 2.7 entry point.
 *
 *   Composes per-kind rules over the normalized input + QueryShape and emits one `PhraseProposal` per
 *   fired rule. Overlapping proposals are expected — the reconciler (Stage 5) picks the best
 *   non-overlapping subset.
 *
 *   See `docs/articles/concepts/the-knowledge-ladder.md` § Phrase grouper for the design rationale,
 *   and `phrase-grouper/rules.ts` for per-rule documentation.
 */

import {
	scoreHyphenatedCompound,
	scoreLocalityPhrase,
	scoreNumeric,
	scorePostcode,
	scoreRegionAbbreviation,
	scoreStreetPhrase,
	scoreVenuePhrase,
	tokenizeSegment,
	type SegmentToken,
} from "./rules.js"
import type { GroupPhrasesOpts, LocaleHint, NormalizedInputLite, PhraseProposal, QueryShapeLike } from "./types.js"

/**
 * Walk every QueryShape segment and emit one `tokens-by-segment` list. Falls back to treating the whole input as a
 * single segment when QueryShape didn't supply segmentation (e.g. callers wiring the grouper into a path that bypasses
 * QueryShape).
 */
function tokensPerSegment(
	text: string,
	shape: QueryShapeLike
): Array<{ tokens: SegmentToken[]; isFirst: boolean; isLast: boolean }> {
	const segs = shape.segments

	if (segs && segs.length > 0) {
		return segs.map((s, idx) => {
			const start = s.span?.start ?? 0
			const end = s.span?.end ?? text.length

			return {
				tokens: tokenizeSegment(text.slice(start, end), start),
				isFirst: idx === 0,
				isLast: idx === segs.length - 1,
			}
		})
	}

	return [{ tokens: tokenizeSegment(text, 0), isFirst: true, isLast: true }]
}

/**
 * Synchronous, pure rule-based implementation. The async wrapper matches the pipeline contract.
 *
 * Emits overlapping proposals freely — the consumer (Stage 5 reconcile) picks the best non-overlapping subset under
 * semantic+hierarchical constraints. Confidence is a [0,1] score per proposal; relative ordering is what matters more
 * than absolute calibration at v0.5.0.
 *
 * The `_locale` parameter is reserved for future locale-aware rule packs (Japanese postcode/honorific patterns, French
 * preposition-bound localities) — currently unused.
 */
export function groupPhrasesSync(
	input: NormalizedInputLite,
	shape: QueryShapeLike,
	_locale?: LocaleHint,
	_opts: GroupPhrasesOpts = {}
): PhraseProposal[] {
	const text = input.normalized

	if (text.length === 0) return []

	const proposals: PhraseProposal[] = []

	// Postcode rule consumes QueryShape directly (segment-agnostic).
	proposals.push(...scorePostcode(shape, text))

	// Per-segment rules.
	for (const { tokens, isFirst, isLast } of tokensPerSegment(text, shape)) {
		if (tokens.length === 0) continue
		proposals.push(...scoreNumeric(tokens, text))
		proposals.push(...scoreRegionAbbreviation(tokens, text, isLast))
		proposals.push(...scoreHyphenatedCompound(tokens, text))
		proposals.push(...scoreStreetPhrase(tokens, text))
		proposals.push(...scoreLocalityPhrase(tokens, text, isLast))
		proposals.push(...scoreVenuePhrase(tokens, text, isFirst))
	}

	// Sort: descending confidence, ties broken by span start (left-to-right). Downstream Stage 5
	// can rely on this ordering for top-k selection without re-sorting.
	proposals.sort((a, b) => {
		if (a.confidence !== b.confidence) return b.confidence - a.confidence

		return a.span.start - b.span.start
	})

	return proposals
}

/**
 * Async variant matching `RuntimePipelineStages.groupPhrases`. Wraps the sync impl so the pipeline coordinator can use
 * it as-is.
 */
export async function groupPhrases(
	input: NormalizedInputLite,
	shape: QueryShapeLike,
	locale?: LocaleHint,
	opts?: GroupPhrasesOpts
): Promise<PhraseProposal[]> {
	return groupPhrasesSync(input, shape, locale, opts)
}
