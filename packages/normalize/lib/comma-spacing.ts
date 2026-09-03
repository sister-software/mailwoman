/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Comma spacing — a comma directly followed by a letter gains one space, so `Biggin Hill,United Kingdom`
 *   reaches stage 2 as `Biggin Hill, United Kingdom`. A tight comma is an ordinary typing pattern, and the parse
 *   is the first stage that reads it differently: with no space, the tokenizer glues `,United` into one piece,
 *   the segmenter still splits, and the decoder labels the glued piece as a street or a locality it is not.
 *
 *   A letter or a digit after the comma triggers the insertion, with one exception: a comma with a digit on
 *   BOTH sides is a numeric separator (`12,5`, `1,000`) and is left as typed. `Köln,50733` has a letter before
 *   the comma, so it is a list separator and gains the space. A space, punctuation or end of input after the
 *   comma is left as typed. The inserted space maps to the comma's own offset, the same rule the `…`
 *   expansion in `punctuation.ts` follows, so every span that starts after it still points into the raw input.
 */

import { identityMap } from "#offset-map"

/**
 * Any letter or decimal digit in any script: the Unicode property classes `\p{L}` and `\p{Nd}`.
 */
const LETTER_OR_DIGIT = /[\p{L}\p{Nd}]/u
const DIGIT = /\p{Nd}/u

export interface CommaSpacingResult {
	text: string
	map: number[]
	/**
	 * How many spaces were inserted.
	 */
	inserted: number
}

/**
 * A comma with a decimal digit on both sides: `12,5`, `1,000`.
 */
function isNumericSeparator(input: string, commaIndex: number): boolean {
	return commaIndex > 0 && DIGIT.test(input[commaIndex - 1]!) && DIGIT.test(input[commaIndex + 1]!)
}

/**
 * Insert one space after every comma that is directly followed by a letter or digit, unless the comma is a numeric
 * separator. Offset-map-correct: the inserted space maps to the comma.
 */
export function spaceAfterComma(input: string): CommaSpacingResult {
	let inserted = 0
	const out: string[] = []
	const map: number[] = []

	for (let i = 0; i < input.length; i++) {
		const ch = input[i]!
		out.push(ch)
		map.push(i)

		if (ch === "," && i + 1 < input.length && LETTER_OR_DIGIT.test(input[i + 1]!) && !isNumericSeparator(input, i)) {
			out.push(" ")
			map.push(i)
			inserted += 1
		}
	}

	if (!inserted) {
		return { text: input, map: identityMap(input.length), inserted: 0 }
	}

	return { text: out.join(""), map, inserted }
}
