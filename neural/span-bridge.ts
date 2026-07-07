/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Punctuation-gap span bridging — the v4.4.0 corrective (and the long-deferred Saint-Albans
 *   span-merge, scoped to where it is provably safe).
 *
 *   The corpus alignment tokenizer drops standalone punctuation (corpus/src/tokenize.ts), so NO
 *   training row can label the periods inside "P.O. Box" — the model learns the tag perfectly
 *   (every letter piece at 0.93+ confidence) but emits it as fragments split at each dot, and span
 *   assembly surfaces only the first fragment ("p"). Measured on the v1.3.0 gate: dotted po_box
 *   leaders failed 98%, ALL truncations, while plain leaders passed — a structural expressivity
 *   limit of the label format, not a learning failure.
 *
 *   The fix is deterministic: AFTER decode, merge adjacent same-label spans whose gap consists only
 *   of punctuation/whitespace, contains at least one non-space character, and is short (≤ 3 chars).
 *   The non-space requirement is essential — space-only gaps ("Saint Paul" as two locality spans)
 *   are NOT bridged, because a space between two same-tag spans is often a real boundary (the
 *   Saint-Albans fragmentation wants this fix too, but it must come with its own evidence; this
 *   pass stays conservative by construction).
 *
 *   Runs beside the postcode/unit repair passes in the classifier, before tree-building.
 */

import type { DecoderToken } from "@mailwoman/core/decoder"

/**
 * Gap text qualifies when short, made only of INTRA-TOKEN punctuation (period/hyphen/slash/ apostrophe) plus
 * whitespace, with at least one non-space char. Separator punctuation (comma, semicolon) is EXCLUDED — measured
 * 2026-06-11: the comma form merged "47110, 9016"-style postcode
 *
 * - House-number fragments on six FR golden rows (the model double-labels the number; the comma is the only thing keeping
 *   the spans honest). A comma between same-tag spans is a list/separator, never the inside of a surface form.
 */
function bridgeable(gap: string): boolean {
	if (gap.length === 0 || gap.length > 3) return false

	if (!/^[.\-/'\u2019\s]*$/.test(gap)) return false

	return /[^\s]/.test(gap)
}

/** Options for {@link bridgePunctuationGaps}. */
export interface BridgePunctuationOpts {
	/**
	 * Structural spans (from the Stage 2.7 span proposer — ANNOTATION/QUOTED groups, delimiters inclusive) whose
	 * boundaries no merge may straddle: M2's crossing constraint, the bridge's mirror image (the bridge merges across
	 * WEAK punctuation; this blocks merging across STRUCTURAL punctuation). A merge is blocked when either span boundary
	 * falls inside the gap being bridged — e.g. an apostrophe-quoted name whose closing quote sits in an
	 * otherwise-bridgeable gap. Boundaries already inside a labeled token are the model's call, not the bridge's; only
	 * gaps are policed.
	 */
	blockedSpans?: ReadonlyArray<{ start: number; end: number }>
}

/** True when a structural boundary falls inside the closed gap interval `[gapStart, gapEnd]`. */
function crossesBlockedBoundary(
	gapStart: number,
	gapEnd: number,
	blockedSpans: ReadonlyArray<{ start: number; end: number }> | undefined
): boolean {
	if (!blockedSpans) return false

	for (const span of blockedSpans) {
		// span.start = opening delimiter index; span.end = one past the closing delimiter.
		if (span.start >= gapStart && span.start <= gapEnd) return true

		if (span.end - 1 >= gapStart && span.end - 1 <= gapEnd) return true
	}

	return false
}

/**
 * Merge same-label fragments separated only by punctuation gaps. Returns a new token array where the first fragment of
 * each bridged group is widened to the group's full char range (so span extraction reads the raw text straight through
 * the punctuation), and later fragments are dropped. Labels, ordering, and all non-bridged tokens are untouched.
 */
export function bridgePunctuationGaps(
	text: string,
	input: readonly DecoderToken[],
	opts?: BridgePunctuationOpts
): DecoderToken[] {
	const out: DecoderToken[] = []

	for (const token of input) {
		if (token.label !== "O") {
			// Look back past any O tokens that sit INSIDE the candidate gap (the punctuation pieces
			// themselves decode as O — they are exactly what we bridge across).
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
