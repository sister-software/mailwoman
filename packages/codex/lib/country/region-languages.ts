/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The languages a REGION's addresses are written in: the country's official languages plus the region's own
 *   co-official ones, in ISO 639-3 (the code the Who's On First names table carries). This is the question a corpus
 *   extraction asks when it turns a region record into the surfaces a person types, and it differs from
 *   {@link isOfficialLanguage} in two ways: it answers per region rather than per country, and it refuses the
 *   country-wide `regional` list, whose languages are official somewhere in the country and not in the region at hand.
 *
 *   Spain is the one country with a per-region table so far; every other country answers with its official languages
 *   alone, which for GB, FR, DE, IT, NL and PT is the language the source addresses are already written in.
 */

import { OFFICIAL_LANGUAGES } from "#country/official-languages"
import { coOfficialLanguagesForProvince } from "#es/co-official-languages"

/**
 * The length of an ISO 639-3 code, the spelling the Who's On First names table uses; the generated table lists each
 * language under its ISO 639-1 spelling too, which is two letters.
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
 * The languages a region's addresses are written in: the country's official languages first, then the region's
 * co-official ones. `regionOfficialName` is the region's name in the country's first official language, the key the
 * per-country tables use.
 */
export function regionLanguagesAlpha3(country: string, regionOfficialName: string): readonly string[] {
	const official = officialLanguagesAlpha3(country)
	const coOfficial = country.toUpperCase() === "ES" ? coOfficialLanguagesForProvince(regionOfficialName) : []

	return [...official, ...coOfficial.filter((code) => !official.includes(code))]
}
