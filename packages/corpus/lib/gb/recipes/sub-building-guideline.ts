/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The British leg of the `postal-unit-guideline` evaluation recipe, from Royal Mail's
 *   {@linkcode GB_SUB_BUILDING_RULES}: the Sub Building Name (`Flat 3`) on its own line, the
 *   Building Number opening the thoroughfare line, then the post town in capitals and the postcode.
 *
 *   The leg writes only `Flat`. The guide's other example, `Suite`, is a Pub 28 designator that
 *   `spliced-unit` and `synthetic-secondary` write. `Flat` does appear in attested training rows,
 *   such as the Isle of Man Land Registry's sub-unit names, but no training recipe draws it as a
 *   designator.
 *
 *   The street name is another held-out place's name with a codex street type.
 */

import { GB_STREET_TYPES, GB_SUB_BUILDING_RULES, isUkPostcode, titleCaseGB } from "@mailwoman/codex/gb"
import { sample } from "@mailwoman/core/random"

import { GEONAMES_POSTAL_COLUMNS } from "#adapters/geonames/postal/adapter"
import {
	drawBoxNumber,
	drawOtherPlaceName,
	drawUnitIdentifier,
	isRenderablePlaceName,
	joinGuidelineLines,
	type PostalGuidelineLeg,
} from "#recipes/postal-guideline/leg"

const DESIGNATOR = "Flat"
const RULES = GB_SUB_BUILDING_RULES.filter((rule) => rule.designator === DESIGNATOR)

/**
 * The street types the leg writes, the commonest of the codex list.
 */
const STREET_TYPES = GB_STREET_TYPES.slice(0, 4)

const ARRANGEMENTS = [
	{ template: "gb-sub-building:comma", separator: ", " },
	{ template: "gb-sub-building:space", separator: " " },
] as const

/**
 * The British Sub Building Name leg.
 */
export const GB_SUB_BUILDING_GUIDELINE_LEG: PostalGuidelineLeg = {
	country: "GB",
	locale: "en-GB",
	rules: RULES,
	designators: [DESIGNATOR],
	placeFromColumns(columns) {
		const postcode = columns[GEONAMES_POSTAL_COLUMNS.postcode]?.trim() ?? ""
		const locality = columns[GEONAMES_POSTAL_COLUMNS.place]?.trim() ?? ""

		// The GeoNames export lists outward codes too.
		// The leg writes only full postcodes.
		if (!postcode.includes(" ") || !isUkPostcode(postcode) || !isRenderablePlaceName(locality)) return null

		return { postcode, locality: locality.toUpperCase() }
	},
	render(random, place, pool) {
		const rule = sample(RULES, random)
		const arrangement = sample(ARRANGEMENTS, random)
		const identifier = drawUnitIdentifier(random, 0.25)
		let houseNumber = drawBoxNumber(random, 1 + Math.floor(random() * 3))

		while (houseNumber === identifier) {
			houseNumber = drawBoxNumber(random, 3)
		}

		const name = titleCaseGB(drawOtherPlaceName(random, place, pool) ?? "station")
		const streetType = sample(STREET_TYPES, random)

		return {
			template: arrangement.template,
			ruleID: rule.id,
			...joinGuidelineLines(
				[
					[["unit", `${DESIGNATOR} ${identifier}`]],
					[
						["house_number", houseNumber],
						["street", `${name} ${streetType.charAt(0).toUpperCase()}${streetType.slice(1)}`],
					],
					[["locality", place.locality]],
					[["postcode", place.postcode]],
				],
				arrangement.separator
			),
		}
	},
}
