// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The PO boxes of a text, read from the tokens of the `structure` family.
 *
 *   A PO box is a run of leader tokens (`PO`, `Box`, `BP`, `Casilla`, `Apartado`) followed
 *   within three tokens by a number: a token of class `digit` or `mixed`.
 *   Every box of the text is reported, in order, and a box ends before the next one starts.
 *
 *   The reader belongs here because the leaders are address primitives of the text and no postcode syntax.
 *   Its input is the `tokenClasses` field of a recognizer that composes `structure`.
 *
 *   A leader is compared without regard to case, over the ASCII letters.
 *   A dotted leader (`P.O.`) reaches this reader as the tokens `P` and `O`,
 *   because a full stop ends a token, so the table lists the undotted words.
 */

import type { TextSpan, TokenClass } from "#types"

/**
 * The words that lead a PO box in one language.
 */
export interface POBoxLeaders {
	/**
	 * A BCP 47 language subtag.
	 */
	readonly language: string
	readonly leaders: readonly string[]
}

/**
 * The PO box leaders of each language, in lower case.
 * `bp` is French, and `casilla` and `apartado` are Spanish.
 */
export const PO_BOX_LEADERS: readonly POBoxLeaders[] = [
	{ language: "en", leaders: ["po", "box"] },
	{ language: "fr", leaders: ["bp"] },
	{ language: "es", leaders: ["casilla", "apartado"] },
]

const LEADER_WORDS: ReadonlySet<string> = new Set(PO_BOX_LEADERS.flatMap(({ leaders }) => leaders))

/**
 * The number of tokens that may stand between a leader and its number.
 */
const NUMBER_REACH = 3

/**
 * Lower-cases ASCII letters only, as the leaders are compared.
 */
function asciiLower(word: string): string {
	return word.replaceAll(/[A-Z]+/g, (run) => run.toLowerCase())
}

/**
 * The spans of the PO boxes among `tokens`, from the first leader to the number, in order.
 *
 * Each span is a fresh object.
 *
 * @param tokens The `tokenClasses` of a recognizer that composes `structure`.
 * @param text The text the tokens index into.
 */
export function poBoxSpans(tokens: readonly TokenClass[], text: string): TextSpan[] {
	const boxes: TextSpan[] = []
	let index = 0

	while (index < tokens.length) {
		if (!LEADER_WORDS.has(asciiLower(tokens[index]!.span.body))) {
			index++

			continue
		}

		let last = index
		let found = false

		for (let next = index + 1; next <= Math.min(index + NUMBER_REACH, tokens.length - 1); next++) {
			const token = tokens[next]!

			if (LEADER_WORDS.has(asciiLower(token.span.body))) {
				last = next

				continue
			}

			if (token.class === "digit" || token.class === "mixed") {
				last = next
				found = true
			}

			break
		}

		if (!found) {
			index++

			continue
		}

		const start = tokens[index]!.span.start
		const end = tokens[last]!.span.end

		boxes.push({ start, end, body: text.slice(start, end) })
		index = last + 1
	}

	return boxes
}
