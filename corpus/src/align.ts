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
 *   5. Emit the located char spans verbatim as `span_starts[]` / `span_ends[]` / `span_tags[]` (the
 *        v0.5.0 char-offset format, #519). The token quantization in step 4 is the part the v0.5.0
 *        rebuild deletes; during the transition both representations ride on every labeled row.
 *
 *   Structural invariants the function preserves (the span ones loudly — a violation throws rather
 *   than quarantines, because it indicates a bug here, not bad source data):
 *
 *   - `tokens.length === labels.length` always.
 *   - Each component contributes at most one contiguous BIO run (no `B-tag … O … I-tag` gaps). This is
 *       enforced by greedy first-match span assignment + ordered token iteration.
 *   - The span triple is sorted ascending by start and non-overlapping.
 *   - `raw` is NFC-normalized (asserted per row; a non-NFC raw makes char offsets ambiguous downstream
 *       — NFD `é` occupies two code units where NFC `é` occupies one — and silently so).
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

	// Build-time NFC assertion (#519 ruling 2: the converter's Unicode-mismatch class dissolves
	// into this check). Char-offset spans over `raw` are only meaningful under ONE normalization
	// form; a non-NFC raw corrupts every downstream offset silently. Loud failure, naming the row.
	if (row.raw.normalize("NFC") !== row.raw) {
		throw new Error(
			`alignRow: raw is not NFC-normalized (source=${row.source}, source_id=${row.source_id}). ` +
				`Char-offset spans over a non-NFC raw are ambiguous downstream — normalize at the adapter boundary. ` +
				`raw=${JSON.stringify(row.raw)}`
		)
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
	assertSpanInvariants(componentSpans, row)
	const tokens = tokenizer.tokenize(row.raw)
	const labels = labelTokens(tokens, componentSpans)

	const labeled: LabeledRow = {
		...row,
		tokens: tokens.map((t) => t.text),
		labels,
		// The v0.5.0 char-offset triple (#519): the located spans, emitted verbatim. The token
		// quantization above is what the rebuild deletes; both ride during the transition.
		span_starts: componentSpans.map((s) => s.start),
		span_ends: componentSpans.map((s) => s.end),
		span_tags: componentSpans.map((s) => s.tag),
	}
	return { kind: "labeled", row: labeled }
}

/**
 * Enforce the #519 span-triple invariants — sorted ascending by start, non-overlapping — loudly.
 *
 * `claimed`-span bookkeeping in `locateSpan` already makes overlap impossible and the caller sorts,
 * so a violation here is a bug in this file, not bad source data: throw (naming the row) rather
 * than quarantine, so the corruption can't ride into a corpus.
 */
function assertSpanInvariants(spans: readonly ComponentSpan[], row: CanonicalRow): void {
	for (let i = 0; i < spans.length; i++) {
		const s = spans[i]!
		if (!(s.start >= 0 && s.start < s.end && s.end <= row.raw.length)) {
			throw new Error(
				`alignRow: span out of bounds (source=${row.source}, source_id=${row.source_id}): ` +
					`${s.tag}@[${s.start}, ${s.end}) over raw of length ${row.raw.length}`
			)
		}
		if (i === 0) continue
		const prev = spans[i - 1]!
		if (s.start < prev.start) {
			throw new Error(
				`alignRow: spans not sorted (source=${row.source}, source_id=${row.source_id}): ` +
					`${prev.tag}@[${prev.start}, ${prev.end}) precedes ${s.tag}@[${s.start}, ${s.end})`
			)
		}
		if (s.start < prev.end) {
			throw new Error(
				`alignRow: spans overlap (source=${row.source}, source_id=${row.source_id}): ` +
					`${prev.tag}@[${prev.start}, ${prev.end}) overlaps ${s.tag}@[${s.start}, ${s.end})`
			)
		}
	}
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
