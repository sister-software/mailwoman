// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Postcode patterns a country's postal authority publishes, in place of libaddressinput's pattern.
 *
 *   `./data.ts` is generated from libaddressinput, and a few of its patterns
 *   admit strings the authority never allocates.
 *   An entry here replaces that country's libaddressinput pattern, and the written
 *   forms of `./written-forms.ts` still add to it.
 *
 *   Each entry is an unanchored pattern in the regex subset JavaScript and Python share,
 *   matched case-insensitively, with a literal space where the canonical code prints one.
 *   An entry states the authority's form and the source it was checked against.
 */

/**
 * Authority postcode patterns keyed by ISO 3166-1 alpha-2.
 */
export const COUNTRY_POSTCODE_AUTHORITY_PATTERNS: Readonly<Record<string, string>> = {
	/**
	 * Eircode: a routing key, then a four-character unique identifier, as in `A65 F4E2` and `D6W 1234`.
	 *
	 * libaddressinput's `[\dA-Z]{3} ?[\dA-Z]{4}` accepts any seven-letter word, such as `Toronto`.
	 *
	 * A routing key is a letter and two digits, or `D6W`.
	 * Every one of the 139 published routing keys starts with a letter from the identifier alphabet.
	 *
	 * The unique identifier draws from the digits and the fifteen letters A, C, D, E, F, H,
	 * K, N, P, R, T, V, W, X and Y, so no Eircode holds B, G, I, J, L, M, O, Q, S, U or Z.
	 */
	IE: "(?:[ACDEFHKNPRTV-Y]\\d{2}|D6W) ?[\\dACDEFHKNPRTV-Y]{4}",
}
