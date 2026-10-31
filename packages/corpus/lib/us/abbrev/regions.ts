/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The state-code contrast rows the country-balanced recipe renders: each US state whose code is also another
 *   country's code, joined to the sample localities and postcodes generated from Who's On First.
 */

import { US_STATE_BY_ABBREVIATION, type USStateAbbreviation } from "@mailwoman/codex/us"

import { US_ABBREV_REGION_SAMPLES } from "#us/abbrev/region-samples"
import { US_STATE_CODES_READ_AS_COUNTRIES } from "#us/state-country-codes"

/**
 * A US state whose code is also a country code, with the localities and postcodes a rendered row draws from.
 */
export interface USAbbrevRegion {
	code: USStateAbbreviation
	name: string
	localities: readonly string[]
	postcodes: readonly string[]
}

/**
 * The command that rewrites the generated samples from the Who's On First databases.
 */
export const US_ABBREV_REGION_SAMPLES_COMMAND = "mailwoman dev generate corpus-us-abbrev-region-samples"

/**
 * Returns one entry per state in {@linkcode US_STATE_CODES_READ_AS_COUNTRIES},
 * joined to its generated samples.
 *
 * @throws When a state has no generated samples.
 * The generated module then predates the codex tables it is keyed by,
 * and the message gives the command that regenerates it.
 */
export function usAbbrevRegions(): readonly USAbbrevRegion[] {
	return US_STATE_CODES_READ_AS_COUNTRIES.map((code) => {
		const samples = US_ABBREV_REGION_SAMPLES[code]

		if (!samples) {
			throw new Error(
				`${code} is a US state code read as a country, but abbrev-region-samples.ts holds no samples for it. ` +
					`Regenerate with: ${US_ABBREV_REGION_SAMPLES_COMMAND}`
			)
		}

		return { code, name: US_STATE_BY_ABBREVIATION[code], localities: samples.localities, postcodes: samples.postcodes }
	})
}
