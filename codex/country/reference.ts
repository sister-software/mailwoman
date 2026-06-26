/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Country-reference annotators derivable with no data table. The flag emoji is a pure function of
 *   the ISO 3166-1 alpha-2 code (two Regional Indicator Symbols), and the alpha-2 itself is the ISO
 *   annotation. Calling code + currency need standard ISO/ITU tables and are tracked as a separate
 *   provenance-built data task — deliberately not hand-typed here (the no-load-bearing-trivia
 *   rule).
 */

import type { AnnotationSet, Annotator } from "@mailwoman/annotations"

const REGIONAL_INDICATOR_BASE = 0x1f1e6
const A_UPPER = "A".charCodeAt(0)

/**
 * The flag emoji for an ISO 3166-1 alpha-2 country code, formed from the two Regional Indicator
 * Symbols (`US` → 🇺🇸). Returns `""` for anything that is not two ASCII letters.
 */
export function countryFlag(alpha2: string): string {
	const code = alpha2.toUpperCase()
	if (!/^[A-Z]{2}$/.test(code)) return ""
	return String.fromCodePoint(...[...code].map((c) => REGIONAL_INDICATOR_BASE + c.charCodeAt(0) - A_UPPER))
}

/**
 * Fill the country-reference slice (flag + ISO 3166 alpha-2) from a resolved country code. Calling
 * code + currency are added once their provenance-built tables land.
 */
export const countryReferenceAnnotator: Annotator = ({ countryCode }): Partial<AnnotationSet> => {
	if (!countryCode || !/^[A-Za-z]{2}$/.test(countryCode)) return {}
	const alpha2 = countryCode.toUpperCase()
	const flag = countryFlag(alpha2)
	return { iso3166: { alpha2 }, ...(flag ? { flag } : {}) }
}
