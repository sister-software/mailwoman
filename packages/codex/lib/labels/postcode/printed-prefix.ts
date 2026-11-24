// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The fixed text a layout prints before a postcode, such as Croatia's `HR-` or Japan's `〒`,
 *   written only when the postcode value doesn't already start with it.
 *
 *   A publisher may store the prefix inside the value: GLEIF holds `HR-21000`,
 *   and Who's On First's name for a Japanese postcode is `〒733-0025`.
 *   Printed again by the layout, that value reads `HR-HR-21000`.
 */

/**
 * The characters that may join a prefix's letters to the digits: a hyphen,
 * an en or em dash, or white space.
 */
const SEPARATOR = "[\\s\\-\\u2013\\u2014]*"

/**
 * A two-letter code or the postal mark written twice or more before the digits,
 * as in `FI-FI-15860`, `FOFO100` or `〒〒733-0025`.
 * The first copy is captured.
 */
const REPEATED_MARK = new RegExp(`^((\\p{L}{2}|〒)${SEPARATOR})(?:\\2${SEPARATOR})+(?=\\p{N})`, "iu")

/**
 * A one-letter code written twice or more before the digits, as in `L-L-1471`.
 *
 * Each copy needs its separator, because a postcode such as Wales' `LL11 1AA` starts with a doubled letter.
 */
const REPEATED_LETTER = /^((\p{L})[\s\-–—]+)(?:\2[\s\-–—]+)+(?=\p{N})/iu

/**
 * Returns `postcode` with a country code or postal mark it repeats written once,
 * keeping the first copy as written: `LT-LT-06321` becomes `LT-06321`.
 */
export function withoutRepeatedPrefix(postcode: string): string {
	return postcode.replace(REPEATED_MARK, "$1").replace(REPEATED_LETTER, "$1")
}

/**
 * Returns `postcode` with `prefix` before it, unless the value already starts with the prefix's mark.
 *
 * The mark is the prefix without its trailing separator, so `CH-` matches `CH-2000`, `ch 2000` and `CH2000`.
 * A value that repeats the mark, as `LT-LT-06321` does, keeps its first copy.
 */
export function withPrintedPrefix(prefix: string, postcode: string): string {
	const value = withoutRepeatedPrefix(postcode)
	const mark = prefix.replace(/[\s\-–—]+$/u, "")

	if (!mark) return prefix + value

	const carried = new RegExp(`^${RegExp.escape(mark)}${SEPARATOR}(?=\\p{N})`, "iu")

	return carried.test(value) ? value : prefix + value
}
