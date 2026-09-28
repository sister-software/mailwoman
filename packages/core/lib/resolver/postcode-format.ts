/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   This module maps postcode formats to country evidence without platform dependencies.
 *   `@mailwoman/resolver` runs in the browser through the demo cascade.
 *   It derives the implied country set here rather than relying on a CLI caller to pass it in.
 *   `geocode-core` re-exports the functions for its consumers and tests.
 */

/**
 * These distinctive postcode formats indicate a country unambiguously.
 *
 * They provide a stronger signal than the language-based coarse placer.
 * The coarse placer conflates GB and US, routing some GB addresses to US namesakes.
 *
 * Letters-first formats never match a US ZIP.
 * Extend this table only with formats verified as non-overlapping.
 */
export const POSTCODE_FORMAT_COUNTRY: ReadonlyArray<{ readonly re: RegExp; readonly country: string }> = [
	// GB `E4 9AZ` — letters-first, ending `\d[A-Z]{2}` and never matching a US ZIP / NL / FR / CA code.
	{ re: /^[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}$/i, country: "GB" },
	// CA `K2P 1L4` — `A#A #A#`, ending `\d[A-Z]\d`, distinct from GB's `\d[A-Z]{2}`.
	{ re: /^[A-Z]\d[A-Z]\s?\d[A-Z]\d$/i, country: "CA" },
	// IE Eircode `D02 AF30` — routing key plus a 4-alnum unique part that separates it from GB's
	// 3-char `\d[A-Z]{2}`; Belfast `BT1 5GS` stays GB because Northern Ireland uses GB postcodes.
	{ re: /^(?:[A-Z]\d{2}|D6W)\s?[A-Z\d]{4}$/i, country: "IE" },
	// NL PC6 is deliberately absent because `\d{4} [A-Z]{2}` is forgeable in parse context —
	// a US house-number plus directional fragment (`1234 NE`) matches it exactly —
	// This table feeds recognizeBarePostcode.
	// That function must never treat a street name as a postcode.
	// NL lives in countriesFromPostcodeFormat instead.
]

/**
 * The country a parsed postcode's format implies, or null.
 */
export function countryFromPostcodeFormat(postcode: string | undefined): string | null {
	const p = postcode?.trim()

	if (!p) return null

	for (const { re, country } of POSTCODE_FORMAT_COUNTRY) if (re.test(p)) return country

	return null
}

/**
 * Spaced `NNN NN` is shared by CZ and SK.
 *
 * SE and GR use the same postcode space.
 * Unlike the country-specific formats in {@link POSTCODE_FORMAT_COUNTRY}, it implies a set.
 *
 * It can check a locale-inferred scope but cannot identify one country.
 */
const SHARED_NNN_NN = /^\d{3} \d{2}$/

/**
 * NL PC6 `1012 LG` — digits-first then two letters, NL-unique as a postcode shape
 * but too forgeable for {@link POSTCODE_FORMAT_COUNTRY}, so it belongs only here
 * where every consumer checks on a bare-postcode tree.
 */
const NL_PC6 = /^\d{4}\s?[A-Z]{2}$/i

/**
 * Returns each country consistent with the parsed postcode format.
 *
 * The function checks the singles table.
 * It also checks the NL PC6 shape and the shared `NNN NN` family.
 *
 * It returns an empty list when the shape implies no country, such as a bare
 * five-digit format shared by US / FR / DE and other countries.
 * Such inputs stay with the locale prior on purpose.
 *
 * Unlike {@link countryFromPostcodeFormat} this is not an unforgeable-in-any-context claim,
 * so consumers apply it only to a tree that is a bare postcode, where the street-fragment
 * collision the singles table must exclude cannot arise.
 */
export function countriesFromPostcodeFormat(postcode: string | undefined): readonly string[] {
	const p = postcode?.trim()

	if (!p) return []

	const single = countryFromPostcodeFormat(p)

	if (single) return [single]

	if (NL_PC6.test(p)) return ["NL"]

	if (SHARED_NNN_NN.test(p)) return ["CZ", "SK", "SE", "GR"]

	return []
}
