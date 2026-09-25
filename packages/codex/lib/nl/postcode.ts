/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Dutch postcodes: four digits then two letters (`1012 LG`), the PC6 level CBS publishes a polygon
 *   for. The surface carries the space or omits it, and both spellings are attested.
 *
 *   This module holds the key form — compact and upper-case — because that is what a gazetteer row,
 *   an anchor-lookup key and a corpus recipe all compare on, and a spaced or lower-case value silently
 *   matches no row. The surface forms belong to the other two NL patterns in the repository:
 *   `POSTCODE_SHAPES`' NL row scans a line for either spelling, and `@mailwoman/core/resolver`'s
 *   `NL_PC6` accepts either on a bare-postcode tree. Neither is anchored on the key.
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
 * Type-predicate for a Dutch postcode in its compact, upper-case key form.
 */
export function isNLPostcodeKey(input: unknown): input is NLPostcodeKey {
	return typeof input === "string" && NL_PC6_KEY_PATTERN.test(input)
}
