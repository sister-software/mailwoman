/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Postcode format → country evidence, pure and platform-free, kept here so `@mailwoman/resolver` (which runs
 *   in the browser via the demo cascade) can derive the implied set itself rather than depending on a CLI-side
 *   caller to thread it; `geocode-core` re-exports everything so its consumers and tests are unmoved.
 */

/**
 * Distinctive postcode formats that unambiguously indicate a country — a stronger signal than the
 * language-based coarse placer, which conflates GB/US and mis-routes GB addresses to US namesakes.
 *
 * The format is unforgeable across these countries: letters-first never matches a US ZIP,
 * so extend only with formats validated as non-overlapping.
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
	// and this table feeds recognizeBarePostcode, which must never touch a street name;
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
 * Spaced `NNN NN` — the CZ/SK/SE/GR shared postcode space, which unlike the
 * {@link POSTCODE_FORMAT_COUNTRY} singles implies a set: it can check a locale-inferred
 * scope but never name one country outright.
 */
const SHARED_NNN_NN = /^\d{3} \d{2}$/

/**
 * NL PC6 `1012 LG` — digits-first then two letters, NL-unique as a postcode shape
 * but too forgeable for {@link POSTCODE_FORMAT_COUNTRY}, so it belongs only here
 * where every consumer checks on a bare-postcode tree.
 */
const NL_PC6 = /^\d{4}\s?[A-Z]{2}$/i

/**
 * Every country a parsed postcode's format is consistent with — the singles table, the NL
 * PC6 shape, and the shared `NNN NN` family — or empty when the shape implies no country,
 * such as a bare 5-digit that reads US/FR/DE and more and stays with the locale prior on purpose.
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
