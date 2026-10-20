/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The Italian leg of the `postal-guideline` evaluation recipe, from Poste Italiane's
 *   {@linkcode IT_CASELLA_POSTALE_RULES}. Two arrangements:
 *
 *   - The fourth and fifth lines: `CASELLA POSTALE`, the number and the office where the box is, then
 *     the CAP, the locality and the province abbreviation.
 *   - The document's own contact address: `Casella Postale`, the number, a dash, the CAP and the
 *     locality.
 *
 *   The document asks for the office without prescribing how to name it. The leg writes it as
 *   `UFFICIO POSTALE` and the locality, the noun the document's fermo posta paragraph uses for a post
 *   office. That wording is this repository's choice rather than a quoted form.
 */

import { IT_CASELLA_POSTALE_RULES } from "@mailwoman/codex/it/casella-postale"

import { GEONAMES_POSTAL_COLUMNS } from "#adapters/geonames/postal/adapter"
import {
	drawBoxNumber,
	isRenderablePlaceName,
	renderGuidelineLine,
	type PostalGuidelineLeg,
} from "#recipes/postal-guideline/leg"

/**
 * The GeoNames postal column holding the province abbreviation (admin2 code), such as `AQ`.
 */
const PROVINCE_CODE_COLUMN = 6
const LINE_FOUR_DESIGNATOR = "CASELLA POSTALE"
const CONTACT_DESIGNATOR = "Casella Postale"
const [LINE_FOUR_RULE, , CONTACT_RULE] = IT_CASELLA_POSTALE_RULES

/**
 * The share of rows written in the line-four arrangement.
 * The rest follow the contact example.
 */
const LINE_FOUR_SHARE = 0.6

/**
 * The Italian casella postale leg.
 */
export const IT_CASELLA_POSTALE_GUIDELINE_LEG: PostalGuidelineLeg = {
	country: "IT",
	locale: "it-IT",
	rules: IT_CASELLA_POSTALE_RULES,
	designators: [LINE_FOUR_DESIGNATOR, CONTACT_DESIGNATOR],
	placeFromColumns(columns) {
		const postcode = columns[GEONAMES_POSTAL_COLUMNS.postcode]?.trim() ?? ""
		const locality = columns[GEONAMES_POSTAL_COLUMNS.place]?.trim() ?? ""
		const region = columns[PROVINCE_CODE_COLUMN]?.trim() ?? ""

		if (!/^\d{5}$/u.test(postcode) || !isRenderablePlaceName(locality) || !/^[A-Z]{2}$/u.test(region)) return null

		return { postcode, locality, region }
	},
	render(random, place) {
		const number = drawBoxNumber(random, 1 + Math.floor(random() * 4))

		if (random() < LINE_FOUR_SHARE) {
			const locality = place.locality.toUpperCase()
			const poBox = `${LINE_FOUR_DESIGNATOR} ${number} UFFICIO POSTALE ${locality}`

			return {
				template: "it-casella-postale:line-4",
				ruleID: LINE_FOUR_RULE.id,
				...renderGuidelineLine(
					IT_CASELLA_POSTALE_GUIDELINE_LEG.country,
					{ po_box: poBox, postcode: place.postcode, locality, region: place.region! },
					", "
				),
			}
		}

		const poBox = `${CONTACT_DESIGNATOR} ${number}`

		return {
			template: "it-casella-postale:contact",
			ruleID: CONTACT_RULE.id,
			...renderGuidelineLine(
				IT_CASELLA_POSTALE_GUIDELINE_LEG.country,
				{ po_box: poBox, postcode: place.postcode, locality: place.locality },
				" – "
			),
		}
	},
}
