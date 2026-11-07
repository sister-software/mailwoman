/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

/**
 * Per-country patterns whose first group is the part of a postcode the key tables store.
 *
 * A US ZIP+4 (`53221-3633`) keys as its five-digit ZIP Code, because a query that states
 * a ZIP Code matches it whether or not the query adds the four-digit extension.
 */
const POSTCODE_KEY_PATTERNS: Readonly<Record<string, RegExp>> = {
	US: /^(\d{5})(?:-?\d{4})?$/u,
}

/**
 * The key a postcode is stored and probed under: the country's reduced form where the
 * country has a pattern, else the postcode upper-cased with its spaces removed.
 * Returns `null` for an empty postcode.
 *
 * The address layer's build and its reader both call this, so one written postcode keys one way.
 */
export function addressPostcodeKey(country: string, postcode: string | null | undefined): string | null {
	const compact = postcode?.trim().toUpperCase().replaceAll(/\s+/gu, "")

	if (!compact) return null

	return POSTCODE_KEY_PATTERNS[country.toUpperCase()]?.exec(compact)?.[1] ?? compact
}
