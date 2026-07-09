/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Fr-FR locale profile (per Phase 0 task 5). Uses the same rule classifier set as en-US for
 *   locale-agnostic primitives, with the French-specific component set: cedex (postal routing),
 *   street_prefix_particle (de la / du / des), and dependent_locality (arrondissement). The
 *   `central_european_street_name` classifier lives in the registry for FR / DE / etc. and is
 *   included here.
 */

import type { LocaleProfile } from "../locale.ts"

export const frFR: LocaleProfile = {
	locale: "fr-FR",
	ruleClassifiers: [
		"alpha_numeric",
		"central_european_street_name",
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
		"street_prefix_particle",
		"street_suffix",
		"unit",
		"venue",
		"attention",
		"po_box",
		"intersection_a",
		"intersection_b",
		"cedex",
		"dependent_locality",
	],
	policy: [],
}
