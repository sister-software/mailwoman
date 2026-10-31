/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The Australian leg of the `postal-guideline` evaluation recipe, from Australia Post's
 *   {@linkcode AU_DELIVERY_GUIDELINE_RULES}: a delivery-service line, then the locality, state and
 *   postcode in capitals.
 *
 *   The leg writes only CARE PO, MS and RMS. The table's PO BOX and LOCKED BAG rows are cited too,
 *   but the `invented-po-box-cedex` training recipe already writes both, so rows using them could not
 *   show that a model reads a form it was not taught.
 */

import { AU_DELIVERY_GUIDELINE_RULES, isAuPostcode, isAuStateAbbreviation } from "@mailwoman/codex/au"
import { sample } from "@mailwoman/core/random"

import { GEONAMES_POSTAL_COLUMNS } from "#adapters/geonames/postal/adapter"
import {
	drawBoxNumber,
	isRenderablePlaceName,
	renderGuidelineLine,
	type PostalGuidelineLeg,
} from "#recipes/postal/guideline/leg"

/**
 * The GeoNames postal column holding the state abbreviation (admin1 code), such as `NSW`.
 */
const STATE_CODE_COLUMN = 4

/**
 * The designators no training recipe writes.
 */
const RENDERED_DESIGNATORS: ReadonlySet<string> = new Set(["CARE PO", "MS", "RMS"])
const RULES = AU_DELIVERY_GUIDELINE_RULES.filter((rule) => RENDERED_DESIGNATORS.has(rule.designator))

const ARRANGEMENTS = [
	{ template: "au-delivery:comma", separator: ", " },
	{ template: "au-delivery:space", separator: " " },
] as const

/**
 * The Australian delivery-service leg.
 */
export const AU_DELIVERY_GUIDELINE_LEG: PostalGuidelineLeg = {
	country: "AU",
	locale: "en-AU",
	rules: RULES,
	designators: RULES.map((rule) => rule.designator),
	placeFromColumns(columns) {
		const postcode = columns[GEONAMES_POSTAL_COLUMNS.postcode]?.trim() ?? ""
		const locality = columns[GEONAMES_POSTAL_COLUMNS.place]?.trim() ?? ""
		const region = columns[STATE_CODE_COLUMN]?.trim() ?? ""

		if (!isAuPostcode(postcode) || !isAuStateAbbreviation(region) || !isRenderablePlaceName(locality)) return null

		return { postcode, locality: locality.toUpperCase(), region }
	},
	render(random, place) {
		const rule = sample(RULES, random)
		const arrangement = sample(ARRANGEMENTS, random)

		const poBox = rule.requiresNumber
			? `${rule.designator} ${drawBoxNumber(random, 1 + Math.floor(random() * 3))}`
			: rule.designator

		return {
			template: arrangement.template,
			ruleID: rule.id,
			...renderGuidelineLine(
				AU_DELIVERY_GUIDELINE_LEG.country,
				{ po_box: poBox, locality: place.locality, region: place.region!, postcode: place.postcode },
				arrangement.separator
			),
		}
	},
}
