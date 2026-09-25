/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { POSTCODE_SHAPES } from "@mailwoman/codex/postcode-shapes"
import type { DecoderToken } from "@mailwoman/core/decoder"

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
 * Re-exports the shared span-repair result type, which {@link repairPostcodeLabels} returns.
 */
export type { RepairResult } from "#span/repair"

/**
 * A detected postcode-shaped substring with its char range and confidence class.
 */
export interface PostcodeMatch extends SpanMatch {
	/**
	 * How far the repair may go without an existing postcode label in the range.
	 *
	 * `numeric` may only snap an existing postcode span, `alnum` may also add a span over admin-area
	 * labels, and `designated`, the digits after a postal marker, may overwrite any label.
	 */
	kind: "alnum" | "numeric" | "designated"
}

/**
 * Lists the per-country postcode shape patterns, most specific first.
 *
 * The table lives in `@mailwoman/codex/postcode-shapes` because the Python trainer
 * reads the same data, and the two copies must not drift.
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
 * Collect non-overlapping postcode matches, preferring more-specific (earlier) patterns.
 */
export function collectMatches(text: string): PostcodeMatch[] {
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
export function repairPostcodeLabels(text: string, input: readonly DecoderToken[]): RepairResult {
	const matches = collectMatches(text)
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
