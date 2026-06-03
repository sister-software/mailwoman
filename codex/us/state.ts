/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   US two-letter postal abbreviations for the 50 states, DC, and the five primary territories.
 *
 *   This is the minimal state primitive `zipcode.ts` needs (a closed abbreviation set + predicate)
 *   without pulling in `@mailwoman/tiger`'s FIPS enums and their `shapefile-parser` dependency —
 *   the point of the codex being a zero-runtime-dep package the browser-pure parser can consume.
 *   The full FIPS-keyed table still lives in `@mailwoman/tiger` (`tiger/state.ts`) and in the
 *   corpus TIGER adapter; folding those onto this set is a deliberate follow-up, not a v1 concern.
 */

/**
 * USPS two-letter abbreviations: the 50 states, the District of Columbia, and the five primary
 * territories (Puerto Rico, Guam, US Virgin Islands, Northern Mariana Islands, American Samoa).
 */
export const US_STATE_ABBREVIATIONS = [
	"AL",
	"AK",
	"AZ",
	"AR",
	"CA",
	"CO",
	"CT",
	"DE",
	"DC",
	"FL",
	"GA",
	"HI",
	"ID",
	"IL",
	"IN",
	"IA",
	"KS",
	"KY",
	"LA",
	"ME",
	"MD",
	"MA",
	"MI",
	"MN",
	"MS",
	"MO",
	"MT",
	"NE",
	"NV",
	"NH",
	"NJ",
	"NM",
	"NY",
	"NC",
	"ND",
	"OH",
	"OK",
	"OR",
	"PA",
	"RI",
	"SC",
	"SD",
	"TN",
	"TX",
	"UT",
	"VT",
	"VA",
	"WA",
	"WV",
	"WI",
	"WY",
	"PR",
	"GU",
	"VI",
	"MP",
	"AS",
] as const satisfies readonly string[]

/** A USPS two-letter state-or-territory abbreviation. */
export type UsStateAbbreviation = (typeof US_STATE_ABBREVIATIONS)[number]

const STATE_ABBREVIATION_SET: ReadonlySet<string> = new Set(US_STATE_ABBREVIATIONS)

/**
 * Type-predicate for a USPS state-or-territory abbreviation. Case-insensitive (`"ca"` and `"CA"`
 * both pass), since the abbreviation arrives from raw address text.
 */
export function isUsStateAbbreviation(input: unknown): input is UsStateAbbreviation {
	return typeof input === "string" && STATE_ABBREVIATION_SET.has(input.toUpperCase())
}
