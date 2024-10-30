/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { AddressParser, Tokenizer } from "mailwoman"
import test from "tape"

/**
 * Global test parser instance.
 */
export const parser = new AddressParser()

function extract(tokenizer: Tokenizer): Record<string, string>[][] {
	return tokenizer.solutions.map((solution) =>
		solution.pair.map((c) => {
			return {
				[c.classification.label]: c.span.body,
				// offset: c.span.start
			}
		})
	)
}

export function assert(
	input: string,
	expected: Record<string, string>[] | Record<string, string>[][],
	firstOnly?: boolean
) {
	const tokenizer = new Tokenizer(input)

	parser.classify(tokenizer)
	parser.solve(tokenizer)

	test(input, (t) => {
		const ext = extract(tokenizer)

		t.deepEquals(firstOnly === false ? ext : ext[0], expected)
		t.end()
	})
}
