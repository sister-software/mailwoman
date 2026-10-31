/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The Australian leg of the `postal-unit-guideline` evaluation recipe, from Australia Post's
 *   {@linkcode AU_UNIT_TYPE_RULES}: the sub-unit type and number, the street number and street on
 *   the same line (`SHOP 3 18 JONES ST`), then the locality, state and postcode in capitals.
 *
 *   The leg writes only the surface forms no training recipe uses as a unit designator. APARTMENT,
 *   APT, OFFICE, ROOM, RM, SUITE, UNIT and PENTHOUSE are Pub 28 designators that `spliced-unit` and
 *   `synthetic-secondary` write, so they are left out. SE is left out because training writes it as a
 *   directional. The slash form (`2/100 SMITH ST`) is left out too: G-NAF rows in training write a
 *   flat number with a slash inside `house_number`, so a row labeling it `unit` would contradict
 *   the training convention rather than test a form the model was not taught.
 *
 *   The street name is another held-out place's name, and the street type is the cited example's
 *   `ST` or `STREET`.
 */

import { AU_UNIT_TYPE_RULES } from "@mailwoman/codex/au"
import { sample } from "@mailwoman/core/random"

import { AU_DELIVERY_GUIDELINE_LEG } from "#au/recipes/delivery-guideline"
import {
	drawBoxNumber,
	drawOtherPlaceName,
	drawUnitIdentifier,
	joinGuidelineLines,
	type PostalGuidelineLeg,
} from "#recipes/postal/guideline/leg"

/**
 * The surface forms the leg writes, keyed by the sub-unit type they write.
 */
const RENDERED_FORMS: Readonly<Record<string, readonly string[]>> = {
	FACTORY: ["FACTORY", "FY"],
	FLAT: ["FLAT", "F"],
	HOUSE: ["HOUSE", "HSE"],
	OFFICE: ["OFF"],
	PENTHOUSE: ["PTHS"],
	SHOP: ["SHOP"],
	STUDIO: ["STUDIO", "STU"],
	TOWNHOUSE: ["TOWNHOUSE", "TNHS"],
	UNIT: ["U"],
	WAREHOUSE: ["WAREHOUSE", "WE"],
}

const RULES = AU_UNIT_TYPE_RULES.filter((rule) => rule.designator in RENDERED_FORMS)
const STREET_TYPES = ["ST", "STREET"] as const

const ARRANGEMENTS = [
	{ template: "au-unit:comma", separator: ", " },
	{ template: "au-unit:space", separator: " " },
] as const

/**
 * The Australian sub-unit leg.
 */
export const AU_UNIT_TYPE_GUIDELINE_LEG: PostalGuidelineLeg = {
	country: "AU",
	locale: "en-AU",
	rules: RULES,
	designators: Object.values(RENDERED_FORMS).flat(),
	placeFromColumns: AU_DELIVERY_GUIDELINE_LEG.placeFromColumns,
	render(random, place, pool) {
		const rule = sample(RULES, random)
		const form = sample(RENDERED_FORMS[rule.designator]!, random)
		const arrangement = sample(ARRANGEMENTS, random)
		const identifier = drawUnitIdentifier(random, 0.2)
		let houseNumber = drawBoxNumber(random, 1 + Math.floor(random() * 3))

		while (houseNumber === identifier) {
			houseNumber = drawBoxNumber(random, 3)
		}

		const name = drawOtherPlaceName(random, place, pool) ?? "jones"

		return {
			template: arrangement.template,
			ruleID: rule.id,
			...joinGuidelineLines(
				[
					[
						["unit", `${form} ${identifier}`],
						["house_number", houseNumber],
						["street", `${name.toUpperCase()} ${sample(STREET_TYPES, random)}`],
					],
					[
						["locality", place.locality],
						["region", place.region!],
						["postcode", place.postcode],
					],
				],
				arrangement.separator
			),
		}
	},
}
