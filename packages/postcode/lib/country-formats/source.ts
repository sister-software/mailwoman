// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The postcode syntax of a country as pattern text: the data the `postal` family is generated from.
 *
 *   The libaddressinput table (`./data.ts`), the authority patterns that replace some of its entries
 *   (`./authority-patterns.ts`) and the written forms (`./written-forms.ts`) hold the patterns.
 *   This module joins them into one anchored pattern text with the spacing tolerated,
 *   and it compiles no `RegExp`.
 *
 *   The generator of the `postal` family and the tool that writes the trainer's
 *   copy of the patterns read it.
 *   The `postal` family's artifact answers serving code, in `../country-formats.ts`.
 */

import { COUNTRY_POSTCODE_AUTHORITY_PATTERNS } from "#country-formats/authority-patterns"
import { COUNTRY_POSTCODE_FORMAT_SOURCES } from "#country-formats/data"
import { COUNTRY_POSTCODE_WRITTEN_FORMS } from "#country-formats/written-forms"

/**
 * One country's postcode syntax as text.
 */
export interface PostcodeSyntaxText {
	/**
	 * The pattern a whole postcode matches, anchored with `^(?:…)$`, in the syntax
	 * of a case-insensitive Unicode `RegExp`.
	 */
	readonly pattern: string
	/**
	 * The literal the country's layout prints immediately before the postcode, such as `MD-`, or null.
	 */
	readonly prefix: string | null
}

/**
 * Rewrites each literal space in a libaddressinput pattern, and an optional `?` after it, as `\s*`.
 *
 * libaddressinput states the form a postal form prints, with one space where the canonical code has one.
 * People type `m113aa`, `BN1  1AA` and `GX111AA`, and spacing is an observation
 * rather than an admission test.
 *
 * A space inside a character class, as in the ZIP+4 separator `[ \-]`, remains unchanged
 * because rewriting it would change the class.
 */
export function tolerateSpacing(pattern: string): string {
	let out = ""
	let inClass = false

	for (let i = 0; i < pattern.length; i++) {
		const c = pattern[i]!

		if (c === "\\") {
			out += c + (pattern[i + 1] ?? "")

			i++

			continue
		}

		if (c === "[") {
			inClass = true
		} else if (c === "]") {
			inClass = false
		}

		if (c === " " && !inClass) {
			out += "\\s*"

			if (pattern[i + 1] === "?") {
				i++
			}

			continue
		}

		out += c
	}

	return out
}

/**
 * The postcode syntax libaddressinput states for `countryCode`, as pattern text,
 * or null when it states none.
 *
 * The pattern is the country's entry in `COUNTRY_POSTCODE_AUTHORITY_PATTERNS`
 * where it has one, and the libaddressinput pattern otherwise, followed by each form
 * `COUNTRY_POSTCODE_WRITTEN_FORMS` adds, each with its spacing tolerated.
 */
export function postcodeSyntaxText(countryCode: string): PostcodeSyntaxText | null {
	const code = countryCode.toUpperCase()
	const source = COUNTRY_POSTCODE_FORMAT_SOURCES[code]

	if (!source) return null

	const base = COUNTRY_POSTCODE_AUTHORITY_PATTERNS[code] ?? source.pattern
	const alternatives = [base, ...(COUNTRY_POSTCODE_WRITTEN_FORMS[code] ?? [])]

	return {
		pattern: `^(?:${alternatives.map((p) => `(?:${tolerateSpacing(p)})`).join("|")})$`,
		prefix: source.prefix ?? null,
	}
}
