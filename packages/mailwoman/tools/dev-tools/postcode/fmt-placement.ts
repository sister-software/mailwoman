/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Reads where a libaddressinput `fmt` layout prints the postcode relative to the locality. The postcode
 *   country-format generator records the answer per country, so a corpus recipe that varies the order reads it from
 *   data rather than from a branch on a country code.
 */

import type { PostcodeLocalityPlacement } from "@mailwoman/postcode/country-formats/data"

/**
 * Whether a `fmt` prints the postcode (`%Z`) before or after the locality (`%C`).
 *
 * A layout that prints only one of the two states no order between them.
 * The answer is then null rather than a guess.
 * The layouts of JP, SG, GI and KY print `%Z` and no `%C`.
 */
export function placementInFormat(fmt: string | undefined): PostcodeLocalityPlacement | null {
	if (!fmt) return null

	const postcode = fmt.indexOf("%Z")
	const locality = fmt.indexOf("%C")

	if (postcode === -1 || locality === -1) return null

	return postcode < locality ? "before_locality" : "after_locality"
}
