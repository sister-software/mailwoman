/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { Span, WordClassifier } from "@mailwoman/core"

/**
 * Regex builder.
 */
const r = (...clauses: string[]) => new RegExp(`^${clauses.join("")}$`)

// Constants for basic pattern components.
const NUMERIC = "\\d{1,5}"
const CYRILLIC_LETTER = "\\u0400-\\u04FF"
const ALPHA = `[a-zA-Z${CYRILLIC_LETTER}]`
const OPTIONAL_LETTER = `[a-zA-Z${CYRILLIC_LETTER}]?`
const DIRECTIONAL = "[nsewNSEW]"

// Common pattern combinations.
// const basicHouseNumber = `${NUMERIC}${OPTIONAL_LETTER}`
const rangeSeparator = "-"
const fractionSeparator = "\\/"

/**
 * Flags for house number classifications, used to distinguish between different types of house numbers.
 */
export type HouseNumberFlag = "alphanumeric" | "numeric" | "fractional" | "directional" | "separator" | "cyrillic"

const cyrillicPattern = new RegExp(`[${CYRILLIC_LETTER}]`)

// note: \u0400-\u04FF represents a-z in the Cyrillic alphabet
const houseNumberPatterns: readonly [RegExp, HouseNumberFlag[]][] = [
	// 10
	[r(NUMERIC), ["numeric"]],

	// 10a
	[r(NUMERIC, ALPHA), ["alphanumeric"]],

	// 10-19
	[r(NUMERIC, rangeSeparator, NUMERIC), ["numeric", "separator"]],

	// 10-19a
	[r(NUMERIC, rangeSeparator, NUMERIC, ALPHA), ["numeric", "separator", "alphanumeric"]],

	// 1/135
	[r(NUMERIC, fractionSeparator, NUMERIC), ["numeric", "fractional", "numeric"]],

	// 1b/135
	[r(NUMERIC, ALPHA, fractionSeparator, NUMERIC), ["alphanumeric", "fractional", "numeric"]],

	// Fractional: 1 3/4
	[/^(\d{1,5}) (\d\/\d)?$/, ["numeric", "separator", "fractional"]],

	// 6N23  (i.e. Kane County, IL)
	[r(NUMERIC, DIRECTIONAL, NUMERIC), ["numeric", "directional"]],

	// W350N5337 (i.e. Waukesha County, WI)
	[r(DIRECTIONAL, NUMERIC, DIRECTIONAL, NUMERIC, "?"), ["directional", "numeric"]],
	// N453
	[r(DIRECTIONAL, NUMERIC), ["directional", "numeric"]],
]

export class HouseNumberClassifier extends WordClassifier {
	public explore(span: Span): void {
		if (!span.flags.has("numeral")) return

		const { previousSibling } = span

		if (previousSibling) {
			// House number must not be preceded by a level or unit designator
			if (previousSibling.is("level_designator")) return

			if (previousSibling.is("unit_designator")) return
		}

		const matches = houseNumberPatterns.filter(([pattern]) => pattern.test(span.normalized))

		if (!matches.length) return

		const flags = new Set<HouseNumberFlag>(matches.map(([, matchFlags]) => matchFlags).flat())

		let confidence = 1

		if (cyrillicPattern.test(span.normalized)) {
			flags.add("cyrillic")
		}

		// It's possible to have 5 digit housenumbers but they are fairly uncommon.
		if (/^\d{5}/.test(span.normalized)) {
			confidence = 0.2
		} else if (/^\d{4}/.test(span.normalized)) {
			confidence = 0.9
		}

		span.classifications.add({
			classification: "house_number",
			confidence,
			flags,
		})
	}
}
