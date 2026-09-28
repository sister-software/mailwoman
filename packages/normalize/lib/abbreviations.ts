/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Abbreviation expansion over the per-locale tables in `@mailwoman/codex/abbreviations`.
 */

import { abbreviationDictionary } from "@mailwoman/codex/abbreviations"

import type { SpanRange } from "#types"

export interface AbbreviationResult {
	text: string
	map: number[]
	expansions: Array<{ from: string; to: string; at: SpanRange }>
}

/**
 * Expand known abbreviations, mapping every expanded character back to its source token's first character.
 */
export function expandAbbreviations(input: string, locale?: string): AbbreviationResult {
	const dict = abbreviationDictionary(locale)
	const lookup = new Map<string, string>()

	for (const entry of dict) {
		lookup.set(entry.from.toLowerCase(), entry.to)
	}

	const out: string[] = []
	const map: number[] = []
	const expansions: Array<{ from: string; to: string; at: SpanRange }> = []

	let i = 0

	while (i < input.length) {
		const ch = input[i]!
		// Unicode-letter-aware so "République" is one token rather than fragmenting on 'é'.
		const isTokenChar = (c: string) => /[\p{L}\p{N}'_-]/u.test(c)

		if (!isTokenChar(ch)) {
			out.push(ch)
			map.push(i)
			i += 1

			continue
		}

		const start = i

		while (i < input.length && isTokenChar(input[i]!)) {
			i += 1
		}

		const token = input.slice(start, i)
		const tokenWithTrailingDot = i < input.length && input[i] === "." ? `${token}.` : token
		const lookupKey = token.replace(/\.$/, "").toLowerCase()
		const expansion = lookup.get(lookupKey)

		if (!expansion) {
			for (let k = 0; k < token.length; k++) {
				out.push(token[k]!)
				map.push(start + k)
			}

			continue
		}

		for (let k = 0; k < expansion.length; k++) {
			out.push(expansion[k]!)
			map.push(start + Math.min(k, token.length - 1))
		}

		expansions.push({
			from: tokenWithTrailingDot,
			to: expansion,
			at: { start, end: i, body: token },
		})

		if (i < input.length && input[i] === ".") {
			i += 1
		}
	}

	return { text: out.join(""), map, expansions }
}
