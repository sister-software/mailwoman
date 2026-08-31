/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Word tokenization + span ownership shared by the word-level demo visualizers.
 *
 *   `SubwordExplorer` and `BIOHighlight` both split the raw input on whitespace and assign each word
 *   to its most specific covering span (the shortest-span owner, the same rule `SpanHighlight`
 *   applies per character). The two copies had to agree for the BIO labels to line up between the
 *   panels, so the split and the owner walk live here.
 */

export interface WordToken {
	/**
	 * The word text as it appears in the input.
	 */
	text: string
	/**
	 * Leading whitespace before this word.
	 */
	whitespace: string
	/**
	 * Start offset in the input string.
	 */
	start: number
	/**
	 * End offset in the input string (exclusive).
	 */
	end: number
}

/**
 * Tokenize the raw input into words, preserving leading whitespace for each token.
 */
export function tokenizeWords(input: string): WordToken[] {
	const words: WordToken[] = []
	let i = 0

	while (i < input.length) {
		let ws = ""

		while (i < input.length && /\s/.test(input[i])) {
			ws += input[i]

			i++
		}

		if (i >= input.length) break
		const start = i

		while (i < input.length && !/\s/.test(input[i])) {
			i++
		}

		words.push({ text: input.slice(start, i), start, end: i, whitespace: ws })
	}

	return words
}

/**
 * A half-open `[start, end)` character range into the input.
 */
export interface CharSpan {
	start: number
	end: number
}

/**
 * Per-word index of the most specific (shortest) span covering it, or `-1` when no span overlaps the word. A word is
 * covered when any part of it falls within the span.
 */
export function shortestSpanOwners(words: readonly CharSpan[], spans: readonly CharSpan[]): number[] {
	const owner: number[] = new Array(words.length).fill(-1)

	for (let w = 0; w < words.length; w++) {
		const wStart = words[w].start
		const wEnd = words[w].end
		let best = -1
		let bestLen = Infinity

		for (let s = 0; s < spans.length; s++) {
			const sp = spans[s]

			if (wStart < sp.end && wEnd > sp.start && sp.end - sp.start < bestLen) {
				bestLen = sp.end - sp.start
				best = s
			}
		}

		owner[w] = best
	}

	return owner
}
