/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   A cardinality filter over the decoder's k best label paths: an address has at most one street, house number,
 *   locality, postcode, venue and region, so a path that opens a second span of one of them is passed over for the
 *   next path that does not.
 */

import type { ComponentTag } from "@mailwoman/codex/component"

import { type ViterbiInput, type ViterbiResult, viterbi, viterbiKBest } from "#viterbi"

/**
 * The tags an address may contain at most once.
 */
export const SINGLETON_TAGS: ReadonlySet<ComponentTag> = new Set([
	"street",
	"house_number",
	"locality",
	"postcode",
	"venue",
	"region",
])

/**
 * The maximum number of label paths the filter checks before falling back to the best path.
 */
export const CARDINALITY_FILTER_DEPTH = 20

/**
 * Which pieces the filter counts: a piece whose text holds a letter, mark or digit.
 *
 * Whitespace and punctuation pieces are left out, because the tree trims them from
 * a span's edge and merges the spans on either side of one.
 */
export function countedPieces(text: string, pieces: ReadonlyArray<{ start: number; end: number }>): boolean[] {
	return pieces.map(({ start, end }) => end > start && /[\p{L}\p{M}\p{N}]/u.test(text.slice(start, end)))
}

/**
 * Whether a label path opens more than one span of a singleton tag.
 *
 * A span opens where the tag changes between counted pieces.
 * Adjacent labels of one tag are one span whether the later one is `B-` or `I-`.
 *
 * The model may open each word of a span with `B-`, and `buildAddressTree` merges adjacent spans of one tag.
 * An uncounted piece neither opens nor ends a span.
 */
export function repeatsSingletonTag(
	path: readonly number[],
	labels: readonly string[],
	counted: readonly boolean[]
): boolean {
	const opened = new Set<string>()
	let previous: string | null = null

	for (const [position, index] of path.entries()) {
		if (!counted[position]) continue

		const label = labels[index] ?? "O"
		const tag = label === "O" ? null : label.slice(2)

		if (tag && tag !== previous && SINGLETON_TAGS.has(tag as ComponentTag)) {
			if (opened.has(tag)) return true

			opened.add(tag)
		}

		previous = tag
	}

	return false
}

/**
 * The filter's choice: the path, and its rank among the k best (0 for the best path).
 *
 * `fellBack` is true when every path repeated a singleton tag and the best path was kept.
 */
export interface CardinalityChoice {
	result: ViterbiResult
	rank: number
	fellBack: boolean
}

/**
 * Decodes the k best paths and returns the first that repeats no singleton tag,
 * or the best path when all do.
 */
export function decodeWithCardinalityFilter(
	input: ViterbiInput,
	labels: readonly string[],
	counted: readonly boolean[],
	depth = CARDINALITY_FILTER_DEPTH
): CardinalityChoice {
	const candidates = viterbiKBest(input, depth)
	const rank = candidates.findIndex((candidate) => !repeatsSingletonTag(candidate.path, labels, counted))

	if (rank === -1) return { result: candidates[0]!, rank: 0, fellBack: true }

	return { result: candidates[rank]!, rank, fellBack: false }
}

/**
 * The Viterbi path, through the cardinality filter when `counted` is given
 * and with the filter's choice beside it.
 */
export function decodeViterbi(
	input: ViterbiInput,
	labels: readonly string[],
	counted: readonly boolean[] | null
): { result: ViterbiResult; cardinality: CardinalityChoice | null } {
	if (!counted) return { result: viterbi(input), cardinality: null }

	const cardinality = decodeWithCardinalityFilter(input, labels, counted)

	return { result: cardinality.result, cardinality }
}
