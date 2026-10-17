/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Whether a whole string is a postcode in one country's format.
 *
 *   `./shapes.ts` finds postcode-shaped spans in a line without knowing the country. This module answers the
 *   narrower question an adapter asks once it holds a country's postcode value: does the value have that
 *   country's form? Argentina's `C1425ABC`, Brunei's `BS8811` and Chile's seven digits are postcodes there, and a
 *   four-digit value in a six-digit country is not.
 */

import { COUNTRY_POSTCODE_FORMAT_SOURCES } from "#postcode/country-formats/data"

/**
 * One country's postcode format, compiled.
 */
export interface CountryPostcodeFormat {
	/**
	 * The anchored, case-insensitive pattern a whole postcode matches.
	 */
	readonly pattern: RegExp
	/**
	 * The literal the country's layout prints immediately before the postcode, such as `MD-`, or null.
	 */
	readonly prefix: string | null
}

const compiled = new Map<string, CountryPostcodeFormat | null>()

/**
 * The postcode format libaddressinput states for `countryCode`, or null when it states none.
 *
 * A null answer means the dataset records no postcode system for the country,
 * as for the United Arab Emirates.
 */
export function countryPostcodeFormat(countryCode: string): CountryPostcodeFormat | null {
	const code = countryCode.toUpperCase()

	if (compiled.has(code)) return compiled.get(code) ?? null

	const source = COUNTRY_POSTCODE_FORMAT_SOURCES[code]
	const format = source ? { pattern: new RegExp(`^(?:${source.pattern})$`, "iu"), prefix: source.prefix ?? null } : null

	compiled.set(code, format)

	return format
}

/**
 * The postcode in `value` when the whole value has `countryCode`'s form, else null.
 *
 * The country-code prefix the layout prints (`MD-` in `MD-2001`) is removed from the value,
 * because the layout prints it again around the postcode component.
 * The value is otherwise returned as written, trimmed.
 *
 * For a country with no stated format the answer is always null.
 */
export function matchCountryPostcode(value: string, countryCode: string): string | null {
	const format = countryPostcodeFormat(countryCode)

	if (!format) return null

	const trimmed = value.trim()

	const unprefixed =
		format.prefix && trimmed.toUpperCase().startsWith(format.prefix)
			? trimmed.slice(format.prefix.length).trim()
			: trimmed

	return format.pattern.test(unprefixed) ? unprefixed : null
}
