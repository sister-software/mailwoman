/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Alignment: turn a `CanonicalRow` (raw + components) into a `LabeledRow` (raw + tokens + BIO
 *   labels) or a `QuarantinedRow` (raw + reason) per the Phase 1 plan.
 *
 *   Pipeline:
 *
 *   1. For each `(tag, value)` in `components`, find the value's character span in `raw`. First try a
 *        verbatim substring match (case-insensitive, whitespace-collapsed). If that fails, fall
 *        back to fuzzy match via `fastest-levenshtein`, with a tunable edit distance threshold.
 *   2. If any component cannot be located, reject the row with a human-readable reason and send it to
 *        the quarantine pile (`reason: "component-not-found:<tag>"` or
 *        `"edit-distance-exceeded:<tag>:<dist>"`).
 *   3. Tokenize `raw` with the supplied `Tokenizer` (defaults to the whitespace tokenizer).
 *   4. For each token: walk the list of component spans, pick the one whose span contains the token's
 *        character range. First token in a component span → `B-<tag>`; subsequent tokens →
 *        `I-<tag>`; no overlap → `O`.
 *
 *   Two structural invariants the function preserves:
 *
 *   - `tokens.length === labels.length` always.
 *   - Each component contributes at most one contiguous BIO run (no `B-tag … O … I-tag` gaps). This is
 *       enforced by greedy first-match span assignment + ordered token iteration.
 */

import type { BioLabel, ComponentTag } from "@mailwoman/core/types"
import { distance as levenshteinDistance } from "fastest-levenshtein"
import { whitespaceTokenizer, type TokenSpan, type Tokenizer } from "./tokenize.js"
import type { CanonicalRow, LabeledRow, QuarantinedRow } from "./types.js"

/** Options for `alignRow`. */
export interface AlignOptions {
	/** Tokenizer to use. Defaults to `whitespaceTokenizer()`. */
	tokenizer?: Tokenizer

	/**
	 * Max Levenshtein edit distance to accept when a verbatim substring match fails. Set `0` to
	 * require verbatim matches only. Default `2`.
	 *
	 * Distance is computed against same-length windows in `raw`, so the threshold scales naturally
	 * with the component value length.
	 */
	maxEditDistance?: number

	/**
	 * Case-insensitive comparison for substring search. Default `true`. The retained span in `raw` is
	 * the original case; only matching is case-insensitive.
	 */
	caseInsensitive?: boolean
}

/** Either a successful labeled row or a quarantined one. */
export type AlignmentResult = { kind: "labeled"; row: LabeledRow } | { kind: "quarantined"; row: QuarantinedRow }

interface ComponentSpan {
	tag: ComponentTag
	start: number
	end: number
}

/** Align a single row. */
export function alignRow(row: CanonicalRow, opts: AlignOptions = {}): AlignmentResult {
	const tokenizer = opts.tokenizer ?? whitespaceTokenizer()
	const maxEditDistance = opts.maxEditDistance ?? 2
	const caseInsensitive = opts.caseInsensitive ?? true

	if (!row.raw) {
		return { kind: "quarantined", row: { row, reason: "raw-empty" } }
	}

	const componentSpans: ComponentSpan[] = []
	const claimed: Array<[number, number]> = []

	const haystack = caseInsensitive ? row.raw.toLowerCase() : row.raw

	for (const [tag, value] of Object.entries(row.components) as Array<[ComponentTag, string | undefined]>) {
		if (!value) continue

		const needle = caseInsensitive ? value.toLowerCase() : value
		const span = locateSpan({ haystack, needle, raw: row.raw, claimed, maxEditDistance })

		if (!span) {
			return {
				kind: "quarantined",
				row: { row, reason: `component-not-found:${tag}` },
			}
		}

		componentSpans.push({ tag, start: span.start, end: span.end })
		claimed.push([span.start, span.end])
	}

	componentSpans.sort((a, b) => a.start - b.start)
	const tokens = tokenizer.tokenize(row.raw)
	const labels = labelTokens(tokens, componentSpans)

	const labeled: LabeledRow = {
		...row,
		tokens: tokens.map((t) => t.text),
		labels,
	}
	return { kind: "labeled", row: labeled }
}

/**
 * Locate `needle` in `haystack` (both already normalized for case if requested), preferring
 * verbatim substring match. Falls back to a fuzzy window scan when verbatim fails and
 * `maxEditDistance > 0`. Already-claimed spans are skipped so two components don't grab overlapping
 * ranges.
 *
 * Returns the span in the original `raw` (not the lower-cased `haystack`).
 */
function locateSpan(args: {
	haystack: string
	needle: string
	raw: string
	claimed: Array<[number, number]>
	maxEditDistance: number
}): { start: number; end: number } | undefined {
	const { haystack, needle, claimed, maxEditDistance } = args
	if (needle.length === 0) return undefined

	// Pass 1: verbatim substring, leftmost non-claimed.
	let from = 0
	while (true) {
		const idx = haystack.indexOf(needle, from)
		if (idx < 0) break
		const end = idx + needle.length
		if (!overlapsClaimed(idx, end, claimed)) return { start: idx, end }
		from = idx + 1
	}

	if (maxEditDistance <= 0) return undefined

	// Pass 2: fuzzy sliding-window. Walk over candidate windows of length `needle.length`
	// across haystack, compute Levenshtein, pick the leftmost window under the threshold.
	const len = needle.length
	for (let i = 0; i + len <= haystack.length; i++) {
		if (overlapsClaimed(i, i + len, claimed)) continue
		const window = haystack.slice(i, i + len)
		if (window === needle) return { start: i, end: i + len } // covered by pass 1, but cheap
		const d = levenshteinDistance(window, needle)
		if (d <= maxEditDistance) return { start: i, end: i + len }
	}

	return undefined
}

function overlapsClaimed(start: number, end: number, claimed: Array<[number, number]>): boolean {
	for (const [a, b] of claimed) {
		if (start < b && a < end) return true
	}
	return false
}

/**
 * Assign BIO labels to tokens given the component spans. Components MUST be sorted by start offset.
 * For each token, find the first component span that contains the token's start offset; if the
 * token is the first one inside that span emit `B-<tag>`, else `I-<tag>`.
 */
function labelTokens(tokens: readonly TokenSpan[], spans: readonly ComponentSpan[]): readonly BioLabel[] {
	const out: BioLabel[] = []
	const seenSpan = new Set<number>() // index into `spans`

	for (const token of tokens) {
		let assigned: BioLabel = "O"
		for (let i = 0; i < spans.length; i++) {
			const s = spans[i]!
			if (token.start >= s.start && token.end <= s.end) {
				if (!seenSpan.has(i)) {
					assigned = `B-${s.tag}` as BioLabel
					seenSpan.add(i)
				} else {
					assigned = `I-${s.tag}` as BioLabel
				}
				break
			}
		}
		out.push(assigned)
	}

	return out
}
