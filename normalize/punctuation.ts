/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Punctuation normalization — fancy quotes / dashes to ASCII equivalents. Identity-length: every
 *   fancy character is a single codepoint that maps to a single ASCII char.
 */

import { identityMap } from "./offset-map.js"

const REPLACEMENTS = new Map<string, string>([
	["‘", "'"], // ‘
	["’", "'"], // ’
	["“", '"'], // “
	["”", '"'], // ”
	["–", "-"], // – en dash
	["—", "-"], // — em dash
	["−", "-"], // − U+2212 minus sign — Japanese IMEs emit this as the block separator (1−2−3)
	["―", "-"], // ― U+2015 horizontal bar — another common JP block separator
	["…", "..."], // … expands; tracked specially
	[" ", " "], // non-breaking space
])

export interface PunctuationResult {
	text: string
	map: number[]
	replacements: number
}

export function applyPunctuation(input: string): PunctuationResult {
	let changed = false
	let replacements = 0
	const out: string[] = []
	const map: number[] = []

	for (let i = 0; i < input.length; i++) {
		const ch = input[i]!
		const sub = REPLACEMENTS.get(ch)

		if (sub === undefined) {
			out.push(ch)
			map.push(i)
		} else {
			changed = true
			replacements += 1

			for (let k = 0; k < sub.length; k++) {
				out.push(sub[k]!)
				map.push(i)
			}
		}
	}

	if (!changed) {
		return { text: input, map: identityMap(input.length), replacements: 0 }
	}

	return { text: out.join(""), map, replacements }
}
