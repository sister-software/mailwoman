/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The ISO 3166-1 jurisdiction an INSEE commune code belongs to.
 *
 * Every French source this repository reads keys its rows by INSEE commune code, and France's
 * overseas departments and collectivities are separate ISO 3166-1 jurisdictions. A reader that
 * labels every INSEE-coded row `FR` therefore mislabels the overseas ones. This module is the one
 * home for that mapping, so the BAN adapter and the French recipes that read the same files agree.
 */

/**
 * The jurisdiction each overseas INSEE department prefix belongs to.
 *
 * An INSEE commune code is five characters.
 * A metropolitan code's department is its first two, including `2A` and `2B` for Corsica,
 * and an overseas code's department is its first three.
 *
 * Every overseas prefix begins `97` or `98`, so three characters separate the
 * two cases without a length test.
 *
 * `984` and `986` are mapped although IGN publishes both files with no header line
 * and no rows, so a row appearing under either is labeled rather than read as metropolitan.
 * `989` Clipperton has no ISO 3166-1 alpha-2 code assigned to it, so a row there
 * has nowhere correct to go and this map leaves it out.
 */
export const COUNTRY_BY_INSEE_DEPARTMENT: Readonly<Record<string, string>> = {
	"971": "GP",
	"972": "MQ",
	"973": "GF",
	"974": "RE",
	"975": "PM",
	"976": "YT",
	"977": "BL",
	"978": "MF",
	"984": "TF",
	"986": "WF",
	"987": "PF",
	"988": "NC",
}

/**
 * Every jurisdiction an INSEE-coded French source can produce, so a caller's `--country`
 * is checked against the set rather than against one value.
 *
 * `TF` and `WF` are in the set and currently yield no rows, because the set describes what
 * the publisher's files can contain rather than what the address-source register has elected.
 */
export const INSEE_COUNTRIES: readonly string[] = ["FR", ...Object.values(COUNTRY_BY_INSEE_DEPARTMENT)]

/**
 * The country a row belongs to, read from its INSEE commune code.
 *
 * A code outside the overseas prefixes is metropolitan France.
 * An empty or short code also reads `FR`, because a missing commune code does
 * not move the row to another country.
 */
export function countryOfInseeCode(codeInsee: string): string {
	return COUNTRY_BY_INSEE_DEPARTMENT[codeInsee.trim().slice(0, 3)] ?? "FR"
}
