/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   En-US locale profile (per Phase 0 task 5). Lists the rule classifier IDs the legacy registry will
 *   assign and the `ComponentTag`s the US locale actually uses. No `weightsPackage` is set in Phase
 *   0 — neural weights ship in Phase 3.
 */

import type { LocaleProfile } from "../locale.js"

export const enUS: LocaleProfile = {
	locale: "en-US",
	ruleClassifiers: [
		"alpha_numeric",
		"chain",
		"compound_level",
		"compound_street",
		"compound_unit_designator",
		"directional",
		"given_name",
		"house_number",
		"intersection",
		"level",
		"level_designator",
		"middle_initial",
		"ordinal",
		"person",
		"personal_suffix",
		"personal_title",
		"place",
		"postcode",
		"road_type",
		"stop_word",
		"street_prefix",
		"street_proper_name",
		"street_suffix",
		"surname",
		"token_position",
		"toponym",
		"unit",
		"unit_designator",
		"whos_on_first",
		"composite_intersection",
		"composite_person",
		"composite_street",
		"composite_street_name",
		"composite_venue",
		"subdivision",
	],
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
