// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Dutch postcodes: four digits then two letters (`1012 LG`), the PC6 level CBS publishes a polygon for.
 *
 *   The surface may include the space or omit it.
 *   Both spellings are attested.
 *
 *   This module holds the key form — compact and upper-case — because that's what a
 *   gazetteer row, an anchor-lookup key and a corpus recipe compare against.
 *   A spaced or lower-case value silently matches no row.
 *
 *   {@linkcode NL_PC6_SURFACE_PATTERN} is the whole code as a person writes it, with either spelling.
 *   `POSTCODE_SHAPES`' NL row scans a line for either spelling and isn't anchored on the key.
 */

import type { Tagged } from "type-fest"

/**
 * A Dutch postcode in its key form: four digits then two upper-case letters without a separator.
 *
 * @category Postal
 * @type string
 * @title Dutch postcode (PC6 key)
 * @pattern ^\d{4}[A-Z]{2}$
 */
export type NLPostcodeKey = Tagged<string, "NLPostcodeKey">

/**
 * The compact PC6 key shape: four digits then two upper-case letters.
 *
 * A space and a lower-case letter are both refused, so a caller normalizes the surface first.
 */
export const NL_PC6_KEY_PATTERN = /^\d{4}[A-Z]{2}$/u

/**
 * The PC6 shape as a person writes it: four digits, an optional white-space character,
 * then two letters in either case.
 */
export const NL_PC6_SURFACE_PATTERN = /^\d{4}\s?[A-Za-z]{2}$/u

/**
 * The length of PC4, the four-digit district code a PC6 postcode starts with.
 */
export const NL_PC4_LENGTH = 4

/**
 * Type-predicate for a Dutch postcode in its compact, upper-case key form.
 */
export function isNLPostcodeKey(input: unknown): input is NLPostcodeKey {
	return typeof input === "string" && NL_PC6_KEY_PATTERN.test(input)
}
