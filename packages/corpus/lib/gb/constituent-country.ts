/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The constituent country of a GB postcode, read from the ONS National Statistics UPRN Lookup.
 *
 *   A GB row labels its constituent country `region`, because WOF records England, Scotland, Wales and
 *   Northern Ireland as `macroregion` places under the United Kingdom.
 *   The postcode-area table in the codex assigns a whole area to one country, which is wrong on the border:
 *   every `SY` postcode maps to Wales, and `SY1` to `SY5` lie in Shrewsbury, England.
 *   NSUL records the country of each UPRN, so the postcode's country is a count of its UPRNs.
 */

import { GB_COUNTRIES } from "@mailwoman/codex/gb/country"
import { NSULLookup } from "@mailwoman/resolver-wof-sqlite/nsul/lookup"
import { nsulDatabasePath } from "@mailwoman/resolver-wof-sqlite/paths"
import type { PathBuilderLike } from "path-ts"

/**
 * What {@link openConstituentCountryReader} answered for one postcode.
 */
export interface ConstituentCountryAnswer {
	/**
	 * The English name of the country holding most of the postcode's UPRNs, such as `Wales`.
	 *
	 * Null when the register assigns no UPRN to the postcode.
	 */
	name: string | null
	/**
	 * Whether the postcode's UPRNs lie in more than one constituent country.
	 */
	straddles: boolean
}

/**
 * Opens `nsul.db` and returns a reader from a GB postcode to its constituent country.
 *
 * The reader holds the database open for the life of the process, as a corpus build reads millions of rows.
 */
export function openConstituentCountryReader(
	databasePath: PathBuilderLike = nsulDatabasePath("nsul.db")
): (postcode: string) => ConstituentCountryAnswer {
	const lookup = new NSULLookup({ databasePath })

	return (postcode) => {
		const countries = lookup.countriesForPostcode(postcode)
		const top = countries[0]

		return { name: top ? GB_COUNTRIES[top.country].name : null, straddles: countries.length > 1 }
	}
}
