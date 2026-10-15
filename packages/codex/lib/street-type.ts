/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The street-type word test for a country, assembled from the codex's per-country tables. The
 *   street-morphology FST that ships beside the weights omits one- and two-letter variants, so the
 *   abbreviations a country writes most, `St` and `Rd` in the US, come from the country's own table.
 */

import { isCanadianStreetWord } from "#ca/street-type"
import { isGermanStreetToken } from "#de/street-type"
import { isFrenchStreetWord } from "#fr/voie"
import { isBritishStreetWord } from "#gb/street-type"
import { isStreetDirectionalToken } from "#us/street/directional"
import { isStreetSuffixToken } from "#us/street/suffix"

/**
 * Reports whether a token is a street-type word or abbreviation in one country's addressing.
 */
export type StreetTypeWordTest = (token: string) => boolean

/**
 * The per-country street-type tests, keyed by ISO 3166-1 alpha-2 code.
 *
 * The US entry reads a USPS directional as a street-type word too, because a trailing `NW`
 * or `SW` belongs to the street and never heads a venue name.
 */
const STREET_TYPE_WORD_TESTS: Readonly<Record<string, readonly StreetTypeWordTest[]>> = {
	CA: [isCanadianStreetWord],
	DE: [isGermanStreetToken],
	FR: [isFrenchStreetWord],
	GB: [isBritishStreetWord],
	US: [isStreetSuffixToken, isStreetDirectionalToken],
}

const NO_STREET_TYPE_WORDS: StreetTypeWordTest = () => false

/**
 * Returns the test for a street-type word or abbreviation in `countryCode`'s addressing,
 * such as `St`, `Rd` and `NW` for the US or `Rue` and `Bd` for France.
 *
 * A country without a table in the codex returns a test that accepts no word.
 */
export function streetTypeWordTestFor(countryCode: string | null): StreetTypeWordTest {
	const tests = countryCode ? STREET_TYPE_WORD_TESTS[countryCode.toUpperCase()] : undefined

	if (!tests) return NO_STREET_TYPE_WORDS

	return (token) => tests.some((test) => test(token))
}
