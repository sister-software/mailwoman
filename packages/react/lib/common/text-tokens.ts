/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Word tokenization + span ownership shared by the word-level visualizers.
 *
 *   A word-level panel splits the raw input on whitespace and assigns each word to its most specific
 *   covering span (the shortest-span owner, the same rule a character-level highlight applies per
 *   character). Two panels must agree for the BIO labels to line up between them, so the split and
 *   the owner walk live here.
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

	// `charAt` answers "" past the end, which no whitespace test matches, so both walks stop at the input's length.
	while (i < input.length) {
		let ws = ""

		while (/\s/.test(input.charAt(i))) {
			ws += input.charAt(i)

			i++
		}

		if (i >= input.length) break
		const start = i

		while (i < input.length && !/\s/.test(input.charAt(i))) {
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
	return words.map((word) => {
		let best = -1
		let bestLen = Infinity

		for (const [s, sp] of spans.entries()) {
			if (word.start < sp.end && word.end > sp.start && sp.end - sp.start < bestLen) {
				bestLen = sp.end - sp.start
				best = s
			}
		}

		return best
	})
}
