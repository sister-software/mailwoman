/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Whitespace collapse — runs of whitespace become a single ASCII space. Newlines and tabs are
 *   preserved as-is (segmentation grammar in QueryShape uses them); inline runs of spaces
 *   collapse.
 */

import { identityMap } from "./offset-map.js"

const INLINE_SPACE = /[ \t]/
const ANY_SPACE = /[ \t\n\r]/

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

	// Trim leading and trailing whitespace.
	let lead = 0

	while (lead < out.length && ANY_SPACE.test(out[lead]!)) lead += 1
	let trail = out.length

	while (trail > lead && ANY_SPACE.test(out[trail - 1]!)) trail -= 1

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
