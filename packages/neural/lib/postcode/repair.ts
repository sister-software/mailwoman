// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import type { DecoderToken } from "@mailwoman/core/decoder"
import { POSTCODE_SHAPES } from "@mailwoman/postcode/frozen-shapes"
import { findPostcodeSpans } from "@mailwoman/postcode/postal-spans"
import { disjointSpans } from "@mailwoman/postcode/recognize/postal"

import type { AnchorSpanMode } from "#anchor-inference"
import {
	collectMatchesFor,
	createLabelSetter,
	isAddSafe,
	isTagLabel,
	type RepairResult,
	type SpanMatch,
	tagOf,
	tokenIndicesOverlapping,
} from "#span/repair"

/**
 * A detected postcode-shaped substring with its char range and confidence class.
 */
export interface PostcodeMatch extends SpanMatch {
	/**
	 * How far the repair may go without an existing postcode label in the range.
	 *
	 * `numeric` may only snap an existing postcode span.
	 * `alnum` may also add a span over admin-area labels.
	 *
	 * `designated` means digits after a postal marker and may overwrite any label.
	 */
	kind: "alnum" | "numeric" | "designated"
}

/**
 * Lists the per-country postcode shape patterns, most specific first.
 *
 * The table is the frozen legacy table in `@mailwoman/postcode/frozen-shapes`.
 * Repair keeps it while model 10.8.0 is the published model, and it is deleted with the
 * legacy-formats family when the first model that declares `span_mode: "postal"` ships.
 */
export const POSTCODE_PATTERNS: ReadonlyArray<{
	label: string
	kind: "alnum" | "numeric" | "designated"
	re: RegExp
}> = POSTCODE_SHAPES

const ADD_OVER_TAGS = new Set<string>(["locality", "dependent_locality", "region", "subregion", "country"])

const POSTCODE_B = "B-postcode" as DecoderToken["label"]
const POSTCODE_I = "I-postcode" as DecoderToken["label"]
const LOCALITY_B = "B-locality" as DecoderToken["label"]
const LOCALITY_I = "I-locality" as DecoderToken["label"]
const OUTSIDE = "O" as DecoderToken["label"]

/**
 * The postcode matches of a card that declares `span_mode: "postal"`, from the `postal` family.
 *
 * The family's candidates are reduced to disjoint spans in the order they compete,
 * and the form of each shape is the match's kind.
 * A candidate with no digit is refused: the family holds shapes made only of letters,
 * and a repair that added a postcode label over a word such as a place name would do harm.
 * A refused candidate hides no other.
 */
function collectPostalMatches(text: string): PostcodeMatch[] {
	return disjointSpans(findPostcodeSpans(text), (span) => /\d/u.test(text.slice(span.start, span.end))).map(
		(span, priority) => ({ start: span.start, end: span.end, kind: span.form, priority })
	)
}

/**
 * Collect non-overlapping postcode matches, preferring more-specific (earlier) patterns.
 *
 * A card that declares `span_mode: "postal"` reads the `postal` family,
 * and any other card reads the frozen table.
 */
export function collectMatches(text: string, spanMode?: AnchorSpanMode | null): PostcodeMatch[] {
	if (spanMode === "postal") return collectPostalMatches(text)

	return collectMatchesFor(POSTCODE_PATTERNS, text).map(({ start, end, priority, pattern }) => ({
		start,
		end,
		kind: pattern.kind,
		priority,
	}))
}

/**
 * Relabels postcode spans in decoded tokens to match postcode-shaped substrings
 * of `text`, without mutating the input.
 *
 * A purely numeric match only corrects an existing postcode label and never creates one.
 *
 * @returns The repaired tokens and the number of labels changed.
 */
export function repairPostcodeLabels(
	text: string,
	input: readonly DecoderToken[],
	spanMode?: AnchorSpanMode | null
): RepairResult {
	const matches = collectMatches(text, spanMode)
	const tokens = input.map((t) => ({ ...t }))

	if (!matches.length) return { tokens, changed: 0 }

	const { setLabel, changeCount } = createLabelSetter(tokens)

	for (const m of matches) {
		const overlap = tokenIndicesOverlapping(tokens, m.start, m.end)

		if (!overlap.length) continue

		const hasPostcode = overlap.some((i) => isTagLabel(tokens[i]!.label, "postcode"))

		if (!hasPostcode) {
			if (m.kind === "numeric") continue

			if (m.kind === "alnum" && !isAddSafe(tokens, overlap, ADD_OVER_TAGS)) continue
		}

		overlap.forEach((i, k) => setLabel(i, k === 0 ? POSTCODE_B : POSTCODE_I))

		for (let j = overlap[0]! - 1; j >= 0 && isTagLabel(tokens[j]!.label, "postcode"); j--) {
			setLabel(j, OUTSIDE)
		}

		const trailing: number[] = []

		for (let j = overlap.at(-1)! + 1; j < tokens.length && isTagLabel(tokens[j]!.label, "postcode"); j++) {
			trailing.push(j)
		}

		if (trailing.length) {
			const after = trailing.at(-1)! + 1
			const connectsToCity = after < tokens.length && tagOf(tokens[after]!.label) === "locality"

			if (connectsToCity) {
				trailing.forEach((j, k) => setLabel(j, k === 0 ? LOCALITY_B : LOCALITY_I))

				if (tokens[after]!.label === "B-locality") {
					setLabel(after, LOCALITY_I)
				}
			} else {
				for (const j of trailing) {
					setLabel(j, OUTSIDE)
				}
			}
		}
	}

	return { tokens, changed: changeCount() }
}
