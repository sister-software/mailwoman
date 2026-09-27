/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Ja-JP locale profile. Lists the `ComponentTag`s the Japanese locale uses.
 */

import type { LocaleProfile } from "#locale/locale"

/**
 * Japanese locale profile: addresses run largest-to-smallest, the reverse of the Western hierarchy.
 */
export const jaJP: LocaleProfile = {
	locale: "ja-JP",
	componentsSupported: [
		"country",
		"postcode",
		"prefecture",
		"municipality",
		"district",
		"block",
		"sub_block",
		"building_number",
		"building_name",
		// Compact numbers ("2-3-16") are one whole-span house_number.
		// The block/sub_block/building_number fine tags label the kanji-designator long form only.
		"house_number",
	],
	policy: [],
}
