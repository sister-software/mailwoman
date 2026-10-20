/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The German leg of the `postal-guideline` evaluation recipe: a Postfach line in place of the street
 *   line, then the PLZ and Ort, as Deutsche Post's page states it ({@linkcode DE_POSTFACH_RULES}).
 *
 *   GeoNames writes a company name as the place of a large customer's PLZ and leaves that row's
 *   accuracy column empty, so the leg keeps only rows with an accuracy value.
 */

import { DE_POSTFACH_RULES, formatPostfachNumber } from "@mailwoman/codex/de/postfach"
import { sample } from "@mailwoman/core/random"

import { GEONAMES_POSTAL_COLUMNS } from "#adapters/geonames/postal/adapter"
import {
	drawBoxNumber,
	isRenderablePlaceName,
	renderGuidelineLine,
	type PostalGuidelineLeg,
} from "#recipes/postal-guideline/leg"

/**
 * The GeoNames postal accuracy column, empty on a large customer's company-name row.
 */
const ACCURACY_COLUMN = 11
const DESIGNATOR = "Postfach"
const EXAMPLE_RULE = DE_POSTFACH_RULES[1].id

const ARRANGEMENTS = [
	{ template: "de-postfach:comma", separator: ", " },
	{ template: "de-postfach:space", separator: " " },
] as const

/**
 * The German Postfach leg.
 */
export const DE_POSTFACH_GUIDELINE_LEG: PostalGuidelineLeg = {
	country: "DE",
	locale: "de-DE",
	rules: DE_POSTFACH_RULES,
	designators: [DESIGNATOR],
	placeFromColumns(columns) {
		const postcode = columns[GEONAMES_POSTAL_COLUMNS.postcode]?.trim() ?? ""
		const locality = columns[GEONAMES_POSTAL_COLUMNS.place]?.trim() ?? ""

		if (!columns[ACCURACY_COLUMN]?.trim()) return null

		if (!/^\d{5}$/u.test(postcode) || !isRenderablePlaceName(locality)) return null

		return { postcode, locality }
	},
	render(random, place) {
		const arrangement = sample(ARRANGEMENTS, random)
		const poBox = `${DESIGNATOR} ${formatPostfachNumber(drawBoxNumber(random, 6))}`

		return {
			template: arrangement.template,
			ruleID: EXAMPLE_RULE,
			...renderGuidelineLine(
				DE_POSTFACH_GUIDELINE_LEG.country,
				{ po_box: poBox, postcode: place.postcode, locality: place.locality },
				arrangement.separator
			),
		}
	},
}
