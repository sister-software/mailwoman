// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The forms a gazetteer lookup tries after a full postcode misses, for each country that has a rule.
 *
 *   A postcode gazetteer may hold a code without its white space, or only the
 *   coarser code the full one starts with.
 *   A rule states the full code's written shape and how long that coarser code is,
 *   so the retry stays inside the one country whose codes have the shape.
 */

import { NL_PC4_LENGTH, NL_PC6_SURFACE_PATTERN } from "#nl/postcode"

/**
 * One country's retry rule.
 */
interface PostcodeRetryRule {
	/**
	 * The shape of the whole full code as a person writes it.
	 */
	surface: RegExp
	/**
	 * The count of leading characters that form the coarser code.
	 */
	stemLength: number
}

/**
 * The retry rule of each country that has one, keyed by ISO 3166-1 alpha-2 code.
 */
const POSTCODE_RETRY_RULES: Readonly<Record<string, PostcodeRetryRule>> = {
	NL: { surface: NL_PC6_SURFACE_PATTERN, stemLength: NL_PC4_LENGTH },
}

/**
 * Returns the forms to try, in order, after `text` missed as a postcode of `country`:
 * the code without its white space, then its coarser code.
 *
 * A form equal to the trimmed text is left out.
 * The list is empty for a country without a rule and for a text outside the rule's shape.
 *
 * @param country An ISO 3166-1 alpha-2 code in either case.
 */
export function postcodeRetryForms(text: string, country: string | null | undefined): string[] {
	const code = country?.toUpperCase()
	const rule = code && Object.hasOwn(POSTCODE_RETRY_RULES, code) ? POSTCODE_RETRY_RULES[code] : null
	const trimmed = text.trim()

	if (!rule || !rule.surface.test(trimmed)) return []

	const joined = trimmed.replaceAll(/\s+/g, "")
	const stem = trimmed.slice(0, rule.stemLength)

	return [joined, stem].filter((form) => form !== trimmed)
}
