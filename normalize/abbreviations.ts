/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Abbreviation expansion — a small bounded dictionary per locale. Initial dict covers en-US street
 *   suffixes + directional prefixes. fr-FR + others added as needed.
 *
 *   This is the INVERSE of the corpus synthesis pass (which produces `Ave` from `Avenue` for
 *   augmentation). Both sides should eventually share dictionaries; for v1 this dict is duplicated
 *   intentionally — refactoring sharing is a separate task.
 */

import type { SpanRange } from "./types.js"

export interface AbbreviationEntry {
	from: string // short form (case-insensitive match)
	to: string // canonical long form
}

const EN_US_DICT: ReadonlyArray<AbbreviationEntry> = [
	// Directional prefixes / suffixes
	{ from: "N", to: "North" },
	{ from: "S", to: "South" },
	{ from: "E", to: "East" },
	{ from: "W", to: "West" },
	{ from: "NE", to: "Northeast" },
	{ from: "NW", to: "Northwest" },
	{ from: "SE", to: "Southeast" },
	{ from: "SW", to: "Southwest" },
	// Street suffixes
	{ from: "St", to: "Street" },
	{ from: "Ave", to: "Avenue" },
	{ from: "Blvd", to: "Boulevard" },
	{ from: "Rd", to: "Road" },
	{ from: "Dr", to: "Drive" },
	{ from: "Ct", to: "Court" },
	{ from: "Ln", to: "Lane" },
	{ from: "Pl", to: "Place" },
	{ from: "Pkwy", to: "Parkway" },
	{ from: "Hwy", to: "Highway" },
	{ from: "Sq", to: "Square" },
	{ from: "Ter", to: "Terrace" },
]

const FR_FR_DICT: ReadonlyArray<AbbreviationEntry> = [
	{ from: "R", to: "Rue" },
	{ from: "Bd", to: "Boulevard" },
	{ from: "Av", to: "Avenue" },
	{ from: "Bvd", to: "Boulevard" },
	{ from: "Pl", to: "Place" },
	{ from: "Imp", to: "Impasse" },
	{ from: "Sq", to: "Square" },
]

function getDictionary(locale: string | undefined): ReadonlyArray<AbbreviationEntry> {
	const lc = (locale ?? "en-US").toLowerCase()

	if (lc.startsWith("fr")) return FR_FR_DICT

	return EN_US_DICT
}

/**
 * The per-locale abbreviation table (short↔long), exposed so consumers can reuse the SAME data instead of duplicating
 * it. The metamorphic gauntlet inverts this table to generate expanded→abbreviated perturbations (`Avenue`→`Ave`); the
 * "no load-bearing trivia" rule means that data lives in exactly one place — here.
 */
export function abbreviationDictionary(locale?: string): ReadonlyArray<AbbreviationEntry> {
	return getDictionary(locale)
}

export interface AbbreviationResult {
	text: string
	map: number[]
	expansions: Array<{ from: string; to: string; at: SpanRange }>
}

/**
 * Expand known abbreviations. Walks the input token-by-token (whitespace-delimited) and rewrites matching tokens to
 * their canonical long form. The output map points every char of the expanded form to its position in the original
 * short form (first char of input token).
 *
 * Case rules: match case-insensitively. Output form preserves the dictionary's canonical casing (`St` → `Street`, `st`
 * → `Street`, `ST` → `Street`).
 */
export function expandAbbreviations(input: string, locale?: string): AbbreviationResult {
	const dict = getDictionary(locale)
	const lookup = new Map<string, string>()

	for (const entry of dict) lookup.set(entry.from.toLowerCase(), entry.to)

	const out: string[] = []
	const map: number[] = []
	const expansions: Array<{ from: string; to: string; at: SpanRange }> = []

	let i = 0

	while (i < input.length) {
		const ch = input[i]!
		// Walk to end of token (non-whitespace, non-punctuation). Unicode-letter-aware so
		// "République" stays one token instead of fragmenting on 'é'.
		const isTokenChar = (c: string) => /[\p{L}\p{N}'_-]/u.test(c)

		if (!isTokenChar(ch)) {
			out.push(ch)
			map.push(i)
			i += 1
			continue
		}
		const start = i

		while (i < input.length && isTokenChar(input[i]!)) i += 1
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

		// Emit expansion; map every char back to start of source token.
		for (let k = 0; k < expansion.length; k++) {
			out.push(expansion[k]!)
			map.push(start + Math.min(k, token.length - 1))
		}
		expansions.push({
			from: tokenWithTrailingDot,
			to: expansion,
			at: { start, end: i, body: token },
		})

		// Skip the trailing period if we consumed an abbreviation with one (e.g. "St." → "Street").
		if (i < input.length && input[i] === ".") i += 1
	}

	return { text: out.join(""), map, expansions }
}
