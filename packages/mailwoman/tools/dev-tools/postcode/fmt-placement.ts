/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Reads where a libaddressinput `fmt` layout prints the postcode relative to the locality and to the block the
 *   locality and region form. The postcode country-format generator records both answers per country, so the
 *   evaluation renderer and the training-time `postcode_move` augmentation read them from data rather than from a
 *   branch on a country code.
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

/**
 * The generated JSON the training-time `postcode_move` augmentation reads.
 * The segments run from the repository root.
 */
export const POSTCODE_LAYOUTS_PATH = ["packages", "trainer", "data", "postcode-layouts.json"] as const

/**
 * Where a layout prints the postcode relative to the block its locality and region fields form.
 *
 * `between` is a layout that prints the postcode inside that block, as India's `%C %Z%n%S` does.
 */
export type PostcodeAdminBlockSide = "before" | "after" | "between"

/**
 * Whether a `fmt` prints the postcode (`%Z`) before, after or inside the block of `%C` and `%S`.
 *
 * Null when the layout prints no postcode or no locality, as the layouts of JP, SG, GI and KY print no `%C`.
 * The answer is then absent rather than a guess.
 */
export function postcodeSideOfAdminBlock(fmt: string | undefined): PostcodeAdminBlockSide | null {
	if (!fmt) return null

	const postcode = fmt.indexOf("%Z")

	if (postcode === -1 || fmt.indexOf("%C") === -1) return null

	const admin = [fmt.indexOf("%C"), fmt.indexOf("%S")].filter((index) => index !== -1)

	if (admin.every((index) => postcode < index)) return "before"

	if (admin.every((index) => postcode > index)) return "after"

	return "between"
}
