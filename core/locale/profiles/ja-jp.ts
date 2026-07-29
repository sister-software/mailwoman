/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Ja-JP locale profile, used in Phase 0 §8 for the forward-compat sanity check (#8 task 8): does
 *   the core abstraction accept a locale that omits `street` and `house_number` entirely without
 *   throwing or tripping a type assertion? If this profile registers cleanly today, Phase 6 (Japan)
 *   does not need a core refactor.
 *
 *   Note: no rule classifiers are listed because the JP profile is neural-only in Phase 6. The rule
 *   pipeline does not produce Japanese-specific tags; declaring an empty list here verifies the
 *   system does not assume there are rule classifiers for every locale.
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
