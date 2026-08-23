/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Diff two parses of the SAME input, over spans rather than over the component map.
 *
 *   The component map is what a comparison reaches for and it loses the thing you need. Two arms that both emit
 *   `locality` tell you nothing about whether the locality MOVED, and a map keyed by tag cannot represent a span that
 *   slid one token left — it looks identical to a span that was replaced. This is not hypothetical: it is how a
 *   regression that turned
 *
 *       Ye Three Lords, 27 Minories, London EC3N 1DE
 *
 *   from `venue "Ye Three Lords" · locality London · street Minories` into `locality "Ye Three Lords"` reads as "the
 *   locality changed" in a map diff, when what actually happened is that two spans were destroyed and a third was
 *   retagged onto the text of one of them.
 *
 *   So spans are matched by OVERLAP first and tag second, which lets the four events be told apart:
 *
 *   - `retagged`  — same text, different tag. The venue that became a locality.
 *   - `moved`     — same tag, different span. The locality that slid onto the neighbouring segment.
 *   - `removed` / `added` — a span with no counterpart at all.
 *   - `confidence` — same tag, same span, the model simply became more or less sure.
 *
 *   That last one is why the confidence delta is carried per span rather than as a headline: a row that did not change
 *   its answer but lost 0.3 of confidence on the deciding span is a row about to flip, and an aggregate cannot say so.
 */

import { flattenTreeNodes } from "./tree-shape.ts"
import type { AddressTree } from "./types.ts"

/**
 * What happened to one span between the two arms.
 *
 * `unchanged` is emitted rather than dropped so a renderer can show context lines; a caller wanting only the changes
 * filters on {@linkcode isChange}.
 */
export type SpanDeltaKind = "added" | "removed" | "retagged" | "moved" | "confidence" | "unchanged"

/**
 * A span-level change, carrying both sides where both exist.
 */
export interface SpanDelta {
	kind: SpanDeltaKind
	/**
	 * The tag on each side. Equal unless `kind` is `retagged`, and one side is absent for `added`/`removed`.
	 */
	tagBefore?: string
	tagAfter?: string
	valueBefore?: string
	valueAfter?: string
	spanBefore?: [number, number]
	spanAfter?: [number, number]
	confidenceBefore?: number
	confidenceAfter?: number
	/**
	 * `after - before`, present only when both sides are. Negative means the arm under test is LESS sure.
	 */
	confidenceDelta?: number
	/**
	 * Where the assertion came from — `rule`, `neural`, `resolver`. A span whose tag is unchanged but whose source moved
	 * from `resolver` to `neural` lost its gazetteer backing, which no tag-level diff can show.
	 */
	sourceBefore?: string
	sourceAfter?: string
	sourceIDBefore?: string
	sourceIDAfter?: string
}

/**
 * Whether a delta represents an actual change, as opposed to a context line.
 */
export function isChange(delta: SpanDelta): boolean {
	return delta.kind !== "unchanged"
}

/**
 * One input's parse on both sides, plus the span-level story of how they differ.
 */
export interface ParseDiff {
	input: string
	spans: SpanDelta[]
	/**
	 * The locale/country call and how sure each arm was of it. A parse that changed nothing else but moved its country
	 * confidence across the scope threshold will geocode somewhere else entirely.
	 */
	localeCountryBefore?: { country: string; confidence: number }
	localeCountryAfter?: { country: string; confidence: number }
	/**
	 * True when no span changed and the locale call is identical — the arms agree on this input.
	 */
	identical: boolean
}

interface Flat {
	tag: string
	value: string
	start: number
	end: number
	confidence: number
	source?: string
	sourceID?: string
}

function toFlat(tree: AddressTree | null | undefined): Flat[] {
	return flattenTreeNodes(tree).map((node) => ({
		tag: String(node.tag),
		value: node.value,
		start: node.start,
		end: node.end,
		confidence: node.confidence,
		...(node.source === undefined ? {} : { source: node.source }),
		...(node.sourceID === undefined ? {} : { sourceID: node.sourceID }),
	}))
}

/**
 * How much of the shorter span the two share, in [0, 1].
 *
 * Overlap rather than equality because the interesting failures move a boundary by a token or two, and an
 * equality-keyed match reports those as a delete plus an insert — which is exactly the information loss this file
 * exists to prevent.
 */
function overlap(a: Flat, b: Flat): number {
	const lo = Math.max(a.start, b.start)
	const hi = Math.min(a.end, b.end)

	if (hi <= lo) return 0

	return (hi - lo) / Math.min(a.end - a.start, b.end - b.start)
}

/**
 * The share of overlap below which two spans are treated as unrelated rather than moved.
 *
 * Half the shorter span: a boundary that slid by a token still matches, while two spans that merely touch at their
 * edges do not, and reporting those as a `moved` would invent a relationship the parse does not assert.
 */
const RELATED_OVERLAP = 0.5

/**
 * Diff two parses of the same input.
 *
 * Matching is greedy on overlap, strongest pair first, with tag equality breaking ties — so a span that kept its tag is
 * preferred over one that merely sits in the same place.
 */
export function diffParse(
	input: string,
	before: AddressTree | null | undefined,
	after: AddressTree | null | undefined,
	locale?: {
		before?: { country: string; confidence: number }
		after?: { country: string; confidence: number }
	}
): ParseDiff {
	const a = toFlat(before)
	const b = toFlat(after)
	const pairs: Array<{ i: number; j: number; score: number }> = []

	for (const [i, left] of a.entries()) {
		for (const [j, right] of b.entries()) {
			const share = overlap(left, right)

			if (share >= RELATED_OVERLAP) {
				pairs.push({ i, j, score: share + (left.tag === right.tag ? 1 : 0) })
			}
		}
	}

	pairs.sort((x, y) => y.score - x.score)

	const takenA = new Set<number>()
	const takenB = new Set<number>()
	const spans: SpanDelta[] = []

	for (const { i, j } of pairs) {
		if (takenA.has(i) || takenB.has(j)) continue

		takenA.add(i)
		takenB.add(j)

		const left = a[i]!
		const right = b[j]!
		const sameSpan = left.start === right.start && left.end === right.end

		const kind: SpanDeltaKind =
			left.tag !== right.tag
				? "retagged"
				: sameSpan
					? left.confidence === right.confidence
						? "unchanged"
						: "confidence"
					: "moved"

		spans.push({
			kind,
			tagBefore: left.tag,
			tagAfter: right.tag,
			valueBefore: left.value,
			valueAfter: right.value,
			spanBefore: [left.start, left.end],
			spanAfter: [right.start, right.end],
			confidenceBefore: left.confidence,
			confidenceAfter: right.confidence,
			confidenceDelta: right.confidence - left.confidence,
			...(left.source === undefined ? {} : { sourceBefore: left.source }),
			...(right.source === undefined ? {} : { sourceAfter: right.source }),
			...(left.sourceID === undefined ? {} : { sourceIDBefore: left.sourceID }),
			...(right.sourceID === undefined ? {} : { sourceIDAfter: right.sourceID }),
		})
	}

	for (const [i, left] of a.entries()) {
		if (takenA.has(i)) continue

		spans.push({
			kind: "removed",
			tagBefore: left.tag,
			valueBefore: left.value,
			spanBefore: [left.start, left.end],
			confidenceBefore: left.confidence,
			...(left.source === undefined ? {} : { sourceBefore: left.source }),
		})
	}

	for (const [j, right] of b.entries()) {
		if (takenB.has(j)) continue

		spans.push({
			kind: "added",
			tagAfter: right.tag,
			valueAfter: right.value,
			spanAfter: [right.start, right.end],
			confidenceAfter: right.confidence,
			...(right.source === undefined ? {} : { sourceAfter: right.source }),
		})
	}

	// Document order, so the rendering reads left-to-right across the address rather than in match order.
	spans.sort((x, y) => (x.spanBefore?.[0] ?? x.spanAfter?.[0] ?? 0) - (y.spanBefore?.[0] ?? y.spanAfter?.[0] ?? 0))

	const localeMoved =
		locale?.before?.country !== locale?.after?.country || locale?.before?.confidence !== locale?.after?.confidence

	return {
		input,
		spans,
		...(locale?.before ? { localeCountryBefore: locale.before } : {}),
		...(locale?.after ? { localeCountryAfter: locale.after } : {}),
		identical: !spans.some(isChange) && !localeMoved,
	}
}

/**
 * Confidence movement below which a same-tag same-span pair is not worth a line of its own.
 *
 * Two hundredths: the decoder's aggregate is a mean over a span's tokens, so a one-token re-scoring moves a long span
 * by a hair and reporting that as a change buries the spans that actually moved.
 */
export const CONFIDENCE_NOISE_FLOOR = 0.02

/**
 * Render a diff the way a reader reads one — the ADDRESS first, then the spans that moved under it.
 *
 * Address-first is the point. An aggregate that reports "18 regressed" without the strings is the shape that let a
 * venue-destroying regression read as a routine count for five runs.
 */
export function renderParseDiff(diff: ParseDiff, options: { context?: boolean } = {}): string {
	const lines: string[] = [diff.input]

	if (diff.identical) {
		lines.push("  (identical)")

		return lines.join("\n")
	}

	const conf = (value?: number): string => (value === undefined ? "—" : value.toFixed(2))

	for (const span of diff.spans) {
		if (span.kind === "unchanged" && !options.context) continue

		if (span.kind === "confidence") {
			const delta = span.confidenceDelta ?? 0

			if (Math.abs(delta) < CONFIDENCE_NOISE_FLOOR && !options.context) continue

			lines.push(
				`  ~ ${span.tagAfter}="${span.valueAfter}"  confidence ${conf(span.confidenceBefore)} → ${conf(span.confidenceAfter)} (${delta >= 0 ? "+" : ""}${delta.toFixed(2)})`
			)

			continue
		}

		if (span.kind === "unchanged") {
			lines.push(`    ${span.tagAfter}="${span.valueAfter}"  ${conf(span.confidenceAfter)}`)

			continue
		}

		if (span.kind === "removed") {
			lines.push(
				`  - ${span.tagBefore}="${span.valueBefore}"  ${conf(span.confidenceBefore)}${span.sourceBefore ? `  [${span.sourceBefore}]` : ""}`
			)

			continue
		}

		if (span.kind === "added") {
			lines.push(
				`  + ${span.tagAfter}="${span.valueAfter}"  ${conf(span.confidenceAfter)}${span.sourceAfter ? `  [${span.sourceAfter}]` : ""}`
			)

			continue
		}

		// retagged / moved — both sides exist, so show the transition on one line.
		const what = span.kind === "retagged" ? `${span.tagBefore} → ${span.tagAfter}` : `${span.tagAfter} moved`
		const where = span.kind === "moved" ? `  [${span.spanBefore?.join()}] → [${span.spanAfter?.join()}]` : ""
		const delta = span.confidenceDelta ?? 0

		lines.push(`  ! ${what}  "${span.valueBefore}" → "${span.valueAfter}"${where}`)

		lines.push(
			`      confidence ${conf(span.confidenceBefore)} → ${conf(span.confidenceAfter)} (${delta >= 0 ? "+" : ""}${delta.toFixed(2)})`
		)

		if (span.sourceBefore !== span.sourceAfter) {
			lines.push(`      source ${span.sourceBefore ?? "—"} → ${span.sourceAfter ?? "—"}`)
		}
	}

	const lb = diff.localeCountryBefore
	const la = diff.localeCountryAfter

	if (lb || la) {
		const moved = lb?.country !== la?.country || lb?.confidence !== la?.confidence

		if (moved) {
			lines.push(
				`  ! locale country ${lb?.country ?? "—"} (${conf(lb?.confidence)}) → ${la?.country ?? "—"} (${conf(la?.confidence)})`
			)
		}
	}

	return lines.join("\n")
}
