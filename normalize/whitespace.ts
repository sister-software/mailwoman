/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Whitespace collapse — runs of whitespace become a single ASCII space. Newlines and tabs are
 *   preserved as-is (segmentation grammar in QueryShape uses them); inline runs of spaces
 *   collapse. The trailing trim also drops trailing sentence-punctuation NOISE (#829 tail): a
 *   trailing `.`/`,`/`;`/`:` (e.g. `…Washington DC.`) glues onto the last token and drops the street
 *   tier (`address_point`→`admin`). Trailing only + a conservative set — leading punctuation and
 *   quotes/brackets are never touched (they can be meaningful). Offset-map-correct via the same slice
 *   as the whitespace trim, so span alignment survives.
 */

import { identityMap } from "./offset-map.js"

const INLINE_SPACE = /[ \t]/
const ANY_SPACE = /[ \t\n\r]/
// Trailing NOISE trimmed off the END of the input: whitespace + the sentence-punctuation that a user
// commonly appends. NOT leading (a leading token is load-bearing) and NOT quotes/brackets/parens.
const TRAILING_NOISE = /[ \t\n\r.,;:]/

export interface WhitespaceResult {
	text: string
	map: number[]
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
			// Preserve newlines as segment separators.
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

			while (i < input.length && INLINE_SPACE.test(input[i]!)) i += 1

			if (i - start > 1) {
				changed = true
				runs += 1
			}
			continue
		}

		// Collapse \r\n into one
		if (ch === "\n" && out[out.length - 1] === "\r") {
			// Already handled in CR branch above by emitting both; skip combiner check
		}
		out.push(ch)
		map.push(i)
		i += 1
	}

	// Trim leading whitespace, and trailing whitespace + sentence-punctuation noise (#829 tail).
	let lead = 0

	while (lead < out.length && ANY_SPACE.test(out[lead]!)) lead += 1
	let trail = out.length

	while (trail > lead && TRAILING_NOISE.test(out[trail - 1]!)) trail -= 1

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
