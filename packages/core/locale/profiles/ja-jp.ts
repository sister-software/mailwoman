/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Ja-JP locale profile, and the core abstraction's forward-compat sanity check (#8): does the
 *   registry accept a locale that omits `street` entirely, and whose hierarchy runs
 *   largest-to-smallest, without throwing or tripping a type assertion? While this profile registers
 *   cleanly, Japan support needs no core refactor.
 *
 *   No rule classifiers are listed because the JP profile is neural-only — the rule pipeline produces
 *   no Japanese-specific tags. The empty list is itself the assertion that nothing in the system
 *   assumes every locale has rule classifiers.
 */

import type { LocaleProfile } from "../locale.ts"

/**
 * Japanese locale profile. Note the reversed hierarchy: Japan addresses run largest-to-smallest.
 */
export const jaJP: LocaleProfile = {
	locale: "ja-JP",
	ruleClassifiers: [],
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
		// D4 (v8 JP encoder design): COMPACT numbers ("2-3-16") are ONE whole-span house_number;
		// the block/sub_block/building_number fine tags label the kanji-designator long form only.
		"house_number",
	],
	policy: [],
}
