/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Returns the languages used to write addresses in a region. The result combines the country's official languages
 *   with the region's co-official languages, using ISO 639-3 codes from the Who's On First names table. Corpus extraction
 *   uses this list to generate address surfaces from a region record. Unlike {@link isOfficialLanguage}, this function
 *   answers per region and excludes the country-wide `regional` list. That list can include languages official in other
 *   regions but not in the current one.
 *
 *   Spain is the only country with a per-region table so far. Other countries return their official languages alone.
 *   For GB and FR, those are the languages already used in source addresses. The same applies to DE, IT, NL and PT.
 */

import { OFFICIAL_LANGUAGES } from "#country/official-languages"
import { coOfficialLanguagesForProvince } from "#es/co-official-languages"

/**
 * The length of an ISO 639-3 code, the spelling the Who's On First names table uses.
 *
 * The generated table also lists each language under its two-letter ISO 639-1 spelling.
 */
const ALPHA3_LENGTH = 3

function isAlpha3(code: string): boolean {
	return code.length === ALPHA3_LENGTH
}

/**
 * The country's official languages in ISO 639-3, or empty for an unknown country.
 */
export function officialLanguagesAlpha3(country: string): readonly string[] {
	return (OFFICIAL_LANGUAGES[country.toUpperCase()]?.official ?? []).filter(isAlpha3)
}

/**
 * The languages a region's addresses are written in: the country's official
 * languages first, then the region's co-official ones.
 *
 * `regionOfficialName` is the region's name in the country's first official language,
 * the key the per-country tables use.
 */
export function regionLanguagesAlpha3(country: string, regionOfficialName: string): readonly string[] {
	const official = officialLanguagesAlpha3(country)
	const coOfficial = country.toUpperCase() === "ES" ? coOfficialLanguagesForProvince(regionOfficialName) : []

	return [...official, ...coOfficial.filter((code) => !official.includes(code))]
}
