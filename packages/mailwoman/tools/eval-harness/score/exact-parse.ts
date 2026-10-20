/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Exact parse scoring: whether a parse's component spans equal a row's annotated spans.
 *
 *   A row is exactly parsed when the multiset of predicted `(tag, start, end)` spans equals the multiset of
 *   annotated spans. Every annotated span must be predicted with its tag and boundaries, and no other span may
 *   be predicted. This differs from the recovered-span diagnostic, which accepts additional predictions.
 *
 *   Normalization. Offsets index the row's `raw` string in UTF-16 code units, the unit both the corpus and
 *   the decoder use. Each span, annotated or predicted, has the whitespace at its edges trimmed before
 *   comparison, so `[0, 5)` over `"Main "` equals `[0, 4)`. Case is not folded because boundaries, not text,
 *   are compared, and the classifier's case normalization preserves length.
 *
 *   Repeated components. Spans are compared as a multiset, so two annotated `locality` spans require two
 *   predicted `locality` spans at those boundaries, and a predicted span duplicated at one position counts
 *   once as matched and once as additional.
 *
 *   Ignored labels. No component tag is ignored. The parse tree's nodes, parents and children alike, all
 *   count as predicted spans. Unlabeled text, the `O` label, is not a span on either side.
 *
 *   Validity. {@linkcode validateAnnotatedSpans} refuses a row whose span columns differ in length, whose
 *   offsets are not integers inside `raw` with `start < end`, whose span is only whitespace, whose tag is not
 *   a {@linkcode ComponentTag}, or whose spans overlap. The scorer throws for such a row instead of scoring
 *   it.
 */

import { COMPONENT_TAGS, type ComponentTag } from "@mailwoman/codex/component"
import { stringifyJSON } from "@mailwoman/core/json"

/**
 * One component span with half-open `[start, end)` offsets into the row's raw text.
 */
export interface ComponentSpan {
	tag: string
	start: number
	end: number
}

/**
 * A row's annotated spans in the corpus column layout.
 */
export interface AnnotatedSpanColumns {
	raw: string
	span_starts: readonly number[]
	span_ends: readonly number[]
	span_tags: readonly string[]
}

/**
 * The comparison of one row's predicted spans against its annotated spans.
 */
export interface ExactParseOutcome {
	/**
	 * The predicted spans equal the annotated spans, with no missing and no additional span.
	 */
	exact: boolean
	/**
	 * Annotated spans with no predicted span at the same tag and boundaries.
	 */
	missing: ComponentSpan[]
	/**
	 * Predicted spans with no annotated span at the same tag and boundaries.
	 */
	additional: ComponentSpan[]
}

const KNOWN_TAGS: ReadonlySet<string> = new Set(COMPONENT_TAGS)

/**
 * Trims whitespace at both edges of a span.
 * A span that is only whitespace trims to `start === end`.
 */
export function trimSpan(raw: string, span: ComponentSpan): ComponentSpan {
	let { start, end } = span

	while (start < end && /\s/u.test(raw[start]!)) {
		start++
	}

	while (end > start && /\s/u.test(raw[end - 1]!)) {
		end--
	}

	return { tag: span.tag, start, end }
}

/**
 * Returns a row's annotated spans, trimmed and sorted by start, or throws naming `rowID` and the defect.
 */
export function validateAnnotatedSpans(row: AnnotatedSpanColumns, rowID: string): ComponentSpan[] {
	const refuse = (reason: string): never => {
		throw new Error(`malformed annotation on row ${rowID}: ${reason}`)
	}

	const count = row.span_tags.length

	if (row.span_starts.length !== count || row.span_ends.length !== count) {
		refuse(`${row.span_starts.length} starts, ${row.span_ends.length} ends, ${count} tags`)
	}

	const spans: ComponentSpan[] = []

	for (let i = 0; i < count; i++) {
		const tag = row.span_tags[i]!
		const start = row.span_starts[i]!
		const end = row.span_ends[i]!

		if (!KNOWN_TAGS.has(tag)) {
			refuse(`span ${i} has unknown tag ${stringifyJSON(tag)}`)
		}

		if (!Number.isInteger(start) || !Number.isInteger(end)) {
			refuse(`span ${i} has non-integer offsets`)
		}

		if (start < 0 || end > row.raw.length || start >= end) {
			refuse(`span ${i} [${start}, ${end}) lies outside a ${row.raw.length}-unit raw or is empty`)
		}

		const trimmed = trimSpan(row.raw, { tag: tag as ComponentTag, start, end })

		if (trimmed.start === trimmed.end) {
			refuse(`span ${i} [${start}, ${end}) holds only whitespace`)
		}

		spans.push(trimmed)
	}

	spans.sort((a, b) => a.start - b.start || a.end - b.end)

	for (let i = 1; i < spans.length; i++) {
		if (spans[i]!.start < spans[i - 1]!.end) {
			refuse(`span [${spans[i]!.start}, ${spans[i]!.end}) overlaps [${spans[i - 1]!.start}, ${spans[i - 1]!.end})`)
		}
	}

	return spans
}

const spanKey = (span: ComponentSpan): string => `${span.tag}\u0000${span.start}\u0000${span.end}`

/**
 * Compares predicted spans against a row's validated annotated spans as multisets.
 *
 * @param annotated The output of {@linkcode validateAnnotatedSpans}.
 * @param predicted Every predicted span; each is trimmed against `raw` here.
 */
export function scoreExactParse(
	raw: string,
	annotated: readonly ComponentSpan[],
	predicted: readonly ComponentSpan[]
): ExactParseOutcome {
	const unmatched = new Map<string, ComponentSpan[]>()

	for (const span of annotated) {
		const key = spanKey(span)
		const bucket = unmatched.get(key)

		if (bucket) {
			bucket.push(span)
		} else {
			unmatched.set(key, [span])
		}
	}

	const additional: ComponentSpan[] = []

	for (const span of predicted) {
		const trimmed = trimSpan(raw, span)
		const bucket = unmatched.get(spanKey(trimmed))

		if (bucket?.length) {
			bucket.pop()
		} else {
			additional.push(trimmed)
		}
	}

	const missing = [...unmatched.values()].flat()

	return {
		exact: missing.length === 0 && additional.length === 0,
		missing,
		additional,
	}
}
