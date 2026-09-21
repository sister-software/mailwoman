/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Merges same-label spans separated by a short punctuation gap after decoding. Whitespace-only
 *   gaps remain separate because they can mark a component boundary.
 */

import type { DecoderToken } from "@mailwoman/core/decoder"

/**
 * Gap text qualifies when it is at most three characters of punctuation and whitespace,
 * with at least one punctuation character.
 *
 * Commas and semicolons remain separators.
 */
/**
 * Tokens a gap may span and still be bridged.
 *
 * Wider gaps are separate spans rather than one interrupted span.
 */
const MAX_BRIDGEABLE_GAP = 3

function bridgeable(gap: string): boolean {
	if (!gap.length || gap.length > MAX_BRIDGEABLE_GAP) return false

	if (!/^[.\-/'\u2019\s]*$/.test(gap)) return false

	return /[^\s]/.test(gap)
}

/**
 * Options for {@link bridgePunctuationGaps}.
 */
export interface BridgePunctuationOpts {
	/**
	 * Structural spans (from the Stage 2.7 span proposer — annotation/quoted groups, delimiters inclusive)
	 * whose boundaries no merge may straddle: M2's crossing constraint, the bridge's mirror image
	 * (the bridge merges across weak punctuation. This blocks merging across structural punctuation).
	 *
	 * A merge is blocked when either span boundary falls inside the gap being bridged —
	 * e.g. an apostrophe-quoted name whose closing quote sits in an otherwise-bridgeable gap.
	 * Boundaries already inside a labeled token are the model's call rather than the bridge's.
	 * Only gaps are policed.
	 */
	blockedSpans?: ReadonlyArray<{ start: number; end: number }>
}

/**
 * True when a structural boundary falls inside the closed gap interval `[gapStart, gapEnd]`.
 */
function crossesBlockedBoundary(
	gapStart: number,
	gapEnd: number,
	blockedSpans: ReadonlyArray<{ start: number; end: number }> | undefined
): boolean {
	if (!blockedSpans) return false

	for (const span of blockedSpans) {
		// span.start = opening delimiter index. Span.end = one past the closing delimiter.
		if (span.start >= gapStart && span.start <= gapEnd) return true

		if (span.end - 1 >= gapStart && span.end - 1 <= gapEnd) return true
	}

	return false
}

/**
 * Merge same-label fragments separated only by punctuation gaps.
 *
 * @returns A new token array where the first fragment of each bridged group is widened to the
 * group's full char range (so span extraction reads the raw text straight through the punctuation),
 * and later fragments are dropped.
 * Labels, ordering, and all non-bridged tokens are untouched.
 */
export function bridgePunctuationGaps(
	text: string,
	input: readonly DecoderToken[],
	opts?: BridgePunctuationOpts
): DecoderToken[] {
	const out: DecoderToken[] = []

	for (const token of input) {
		if (token.label !== "O") {
			// Look back past any O tokens that sit inside the candidate gap
			// (the punctuation pieces themselves decode as O — they are exactly what we bridge across).
			let back = out.length - 1

			while (back >= 0 && out[back]!.label === "O" && out[back]!.start >= (out[back - 1]?.end ?? 0)) {
				back--
			}

			const prev = back >= 0 ? out[back]! : undefined
			const tag = token.label.replace(/^[BI]-/, "")
			const prevTag = prev?.label.replace(/^[BI]-/, "")
			const skipped = out.slice(back + 1)
			const skippedInsideGap = prev !== undefined && skipped.every((t) => t.start >= prev.end && t.end <= token.start)

			if (
				prev &&
				prev.label !== "O" &&
				prevTag === tag &&
				token.start >= prev.end &&
				skippedInsideGap &&
				bridgeable(text.slice(prev.end, token.start)) &&
				!crossesBlockedBoundary(prev.end, token.start, opts?.blockedSpans)
			) {
				// Widen the previous fragment through the gap (absorbing the punctuation O tokens);
				// keep the lower confidence so the merged span never overstates its weakest piece.
				out.length = back + 1

				out[back] = {
					...prev,
					end: token.end,
					piece: text.slice(prev.start, token.end),
					confidence: Math.min(prev.confidence, token.confidence),
				}

				continue
			}
		}

		out.push(token)
	}

	return out
}
