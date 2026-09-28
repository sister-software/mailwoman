/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Whitespace collapse, where a run of inline whitespace (`[ \t]`) becomes one ascii space at every
 *   run length so a lone tab normalizes exactly as a doubled one does. Newlines (`\n`/`\r`) are
 *   preserved because QueryShape's segmentation grammar reads one as a segment separator on a par
 *   with a comma, and it reads a raw tab the same way, so folding every tab here keeps a
 *   tab-separated export from re-segmenting the query.
 *
 *   The trailing trim drops trailing sentence-punctuation noise, since a trailing full stop, comma,
 *   semicolon or colon glues onto the last token and drops the street tier (`address_point` to
 *   `admin`). Trailing punctuation only, and a conservative set, because leading punctuation and
 *   quotes or brackets can be meaningful.
 *
 *   Offset-map-correct via the same substring step as the whitespace trim, so span alignment
 *   survives.
 */

import { identityMap } from "#offset-map"

const INLINE_SPACE = /[ \t]/
const ANY_SPACE = /[ \t\n\r]/
/**
 * Trailing noise trimmed off the end of the input, whitespace plus the sentence punctuation a user
 * commonly appends.
 *
 * It applies to the trailing end only, since a leading token is required, and excludes quotes,
 * brackets and parentheses.
 */
const TRAILING_NOISE = /[ \t\n\r.,;:]/

export interface WhitespaceResult {
	text: string
	map: number[]
	/**
	 * How many inline-whitespace runs were rewritten.
	 *
	 * A run longer than one character, or a one-character run that was not already an ascii space.
	 *
	 * A run that was already a single space is not one of them.
	 */
	runs: number
}

export function collapseWhitespace(input: string): WhitespaceResult {
	let changed = false
	let runs = 0
	const out: string[] = []
	const map: number[] = []
	let i = 0

	while (i < input.length) {
		const ch = input[i]!

		if (ch === "\n" || ch === "\r") {
			out.push(ch)
			map.push(i)
			i += 1

			continue
		}

		if (INLINE_SPACE.test(ch)) {
			out.push(" ")
			map.push(i)
			const start = i
			i += 1

			while (i < input.length && INLINE_SPACE.test(input[i]!)) {
				i += 1
			}

			// A one-character run counts too when the character is not already an ascii space,
			// since the tab-to-space rewrite emitted above is a real edit and `changed` decides
			// whether the caller receives it. The early return below otherwise hands back the
			// untouched input.
			if (i - start > 1 || ch !== " ") {
				changed = true
				runs += 1
			}

			continue
		}

		out.push(ch)
		map.push(i)
		i += 1
	}

	let lead = 0

	while (lead < out.length && ANY_SPACE.test(out[lead]!)) {
		lead += 1
	}

	let trail = out.length

	while (trail > lead && TRAILING_NOISE.test(out[trail - 1]!)) {
		trail -= 1
	}

	if (lead > 0 || trail < out.length) {
		changed = true
	}

	const trimmedOut = out.slice(lead, trail)
	const trimmedMap = map.slice(lead, trail)

	if (!changed && trimmedOut.length === input.length) {
		return { text: input, map: identityMap(input.length), runs: 0 }
	}

	return { text: trimmedOut.join(""), map: trimmedMap, runs }
}
