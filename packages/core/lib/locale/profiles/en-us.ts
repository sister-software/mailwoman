/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   En-US locale profile. Lists the `ComponentTag`s the US locale uses.
 */

import type { LocaleProfile } from "#locale/locale"

/**
 * US English locale profile.
 */
export const enUS: LocaleProfile = {
	locale: "en-US",
	componentsSupported: [
		"country",
		"region",
		"locality",
		"postcode",
		"house_number",
		"street",
		"street_prefix",
		"street_suffix",
		"unit",
		"venue",
		"attention",
		"po_box",
		"intersection_a",
		"intersection_b",
	],
	policy: [],
}
