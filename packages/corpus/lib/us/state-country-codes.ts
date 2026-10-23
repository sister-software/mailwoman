/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The USPS state codes that are also the ISO 3166-1 alpha-2 code of a different country, computed from the
 *   codex tables rather than typed. `CA` after a US locality is California, and the same two letters after a
 *   street in Toronto are Canada, so the country-balanced recipe renders the US reading for every such code.
 */

import { CountryISO2 } from "@mailwoman/codex/country"
import { US_STATE_ABBREVIATIONS, US_TERRITORY_ABBREVIATIONS, type USStateAbbreviation } from "@mailwoman/codex/us"

const COUNTRY_CODES: ReadonlySet<string> = new Set(Object.values(CountryISO2))
const TERRITORIES: ReadonlySet<string> = new Set(US_TERRITORY_ABBREVIATIONS)

/**
 * The USPS state codes a parser can read as another country's ISO 3166-1 alpha-2 code.
 *
 * The five territories are left out, because each holds the same code under both readings,
 * so a row with one of them reads the same either way.
 */
export const US_STATE_CODES_READ_AS_COUNTRIES: readonly USStateAbbreviation[] = US_STATE_ABBREVIATIONS.filter(
	(code) => COUNTRY_CODES.has(code) && !TERRITORIES.has(code)
)
