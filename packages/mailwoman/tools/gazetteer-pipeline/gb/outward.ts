/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   GB outward district from a unit postcode, read from the postcode's shape so that spaced and
 *   unspaced GB datasets yield the same district.
 */

import { UK_POSTCODE_PATTERN } from "@mailwoman/codex/gb"

/**
 * GB inward code length (`\d[A-Z]{2}`).
 * The outward code is everything before it.
 */
const GB_INWARD_LENGTH = 3

/**
 * Returns GB outward district from a unit postcode key.
 *
 * Accepts spaced or unspaced forms.
 * Every string outside the GB unit shape returns `null`.
 */
export function gbOutwardFromKey(name: string): string | null {
	const key = (name || "").trim().toUpperCase().replaceAll(" ", "")

	if (!UK_POSTCODE_PATTERN.test(key)) return null

	return key.slice(0, -GB_INWARD_LENGTH)
}
