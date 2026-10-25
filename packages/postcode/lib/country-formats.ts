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

import { COUNTRY_POSTCODE_FORMAT_SOURCES, type PostcodeLocalityPlacement } from "#country-formats/data"
import { COUNTRY_POSTCODE_WRITTEN_FORMS } from "#country-formats/written-forms"

/**
 * One country's postcode format, compiled.
 */
export interface PostcodeSyntax {
	/**
	 * The anchored, case-insensitive pattern a whole postcode matches.
	 */
	readonly pattern: RegExp
	/**
	 * The literal the country's layout prints immediately before the postcode, such as `MD-`, or null.
	 */
	readonly prefix: string | null
}

const compiled = new Map<string, PostcodeSyntax | null>()

/**
 * Rewrites each literal space in a libaddressinput pattern, and an optional `?` after it, as `\s*`.
 *
 * libaddressinput states the form a postal form prints, with one space where the canonical code has one.
 * People type `m113aa`, `BN1  1AA` and `GX111AA`, and spacing is an observation
 * rather than an admission test.
 *
 * A space inside a character class, as in the ZIP+4 separator `[ \-]`, is left alone
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
 * The postcode format libaddressinput states for `countryCode`, or null when it states none.
 *
 * The compiled pattern accepts any case and any run of whitespace, including none,
 * where the stated form has a space, and each form `COUNTRY_POSTCODE_WRITTEN_FORMS` adds.
 * A null answer means the dataset records no postcode system for the country,
 * as for the United Arab Emirates.
 */
export function postcodeSyntax(countryCode: string): PostcodeSyntax | null {
	const code = countryCode.toUpperCase()

	if (compiled.has(code)) return compiled.get(code) ?? null

	const source = COUNTRY_POSTCODE_FORMAT_SOURCES[code]

	// A written form libaddressinput omits, such as a ZIP+4 with no separator, is one more alternative.
	const alternatives = source ? [source.pattern, ...(COUNTRY_POSTCODE_WRITTEN_FORMS[code] ?? [])] : []

	const format = source
		? {
				pattern: new RegExp(`^(?:${alternatives.map((p) => `(?:${tolerateSpacing(p)})`).join("|")})$`, "iu"),
				prefix: source.prefix ?? null,
			}
		: null

	compiled.set(code, format)

	return format
}

/**
 * Whether `countryCode`'s layout prints the postcode before or after the locality,
 * as libaddressinput's `fmt` states it.
 *
 * Null when the dataset states no postcode for the country, or when its layout prints
 * only one of the two fields, as Japan's and Singapore's do.
 * A caller that needs an order treats null as "unknown" rather than picking one.
 */
export function postcodePlacement(countryCode: string): PostcodeLocalityPlacement | null {
	return COUNTRY_POSTCODE_FORMAT_SOURCES[countryCode.toUpperCase()]?.postcodePlacement ?? null
}

/**
 * Every country whose stated postcode format the whole of `value` matches, in ISO 3166-1 alpha-2 order.
 *
 * A bare five-digit value matches dozens of countries and `SW1A 1AA` matches GB alone,
 * so the list's size is the shape's own ambiguity.
 */
export function countriesAcceptingPostcode(value: string): string[] {
	return Object.keys(COUNTRY_POSTCODE_FORMAT_SOURCES)
		.toSorted()
		.filter((code) => acceptPostcode(value, code) !== null)
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
export function acceptPostcode(value: string, countryCode: string): string | null {
	const format = postcodeSyntax(countryCode)

	if (!format) return null

	const trimmed = value.trim()

	const unprefixed =
		format.prefix && trimmed.toUpperCase().startsWith(format.prefix)
			? trimmed.slice(format.prefix.length).trim()
			: trimmed

	return format.pattern.test(unprefixed) ? unprefixed : null
}
