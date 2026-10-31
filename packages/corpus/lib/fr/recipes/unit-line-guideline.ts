/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The French leg of the `postal-unit-guideline` evaluation recipe, from La Poste's
 *   {@linkcode FR_UNIT_LINE_RULES}: one line 2 or line 3 designator with its identifier, the number
 *   and street on line 4, then the postcode and locality on line 6, in capitals as the document's
 *   example writes lines 3 to 6.
 *
 *   The leg leaves out ESCALIER and ENTREE, because `synthetic-secondary` writes `Escalier 4` and
 *   `Entrée C`. The flat is written as the example's `Appartement` or as line 2's `APP`. A
 *   residence or housing estate takes another held-out place's name as its identifier. Every other
 *   designator takes a number or a letter. The street is the example's `RUE DE` and another held-out place's name.
 */

import { FR_UNIT_LINE_RULES } from "@mailwoman/codex/fr"
import { sample } from "@mailwoman/core/random"

import { GEONAMES_POSTAL_COLUMNS } from "#adapters/geonames/postal/adapter"
import {
	drawBoxNumber,
	drawOtherPlaceName,
	drawUnitIdentifier,
	isRenderablePlaceName,
	joinGuidelineLines,
	type PostalGuidelineLeg,
} from "#recipes/postal/guideline/leg"

/**
 * The designators a training recipe already writes.
 */
const TRAINING_DESIGNATORS: ReadonlySet<string> = new Set(["ESCALIER", "ENTREE"])
const RULES = FR_UNIT_LINE_RULES.filter((rule) => !TRAINING_DESIGNATORS.has(rule.designator))

/**
 * The designators whose identifier is a place name rather than a number or letter.
 */
const NAMED_DESIGNATORS: ReadonlySet<string> = new Set(["RESIDENCE", "LOTISSEMENT"])

/**
 * The surface forms the leg writes for a designator.
 */
function formsOf(designator: string): readonly string[] {
	return designator === "APPARTEMENT" ? ["Appartement", "APP"] : [designator]
}

const ARRANGEMENTS = [
	{ template: "fr-unit-line:comma", separator: ", " },
	{ template: "fr-unit-line:space", separator: " " },
] as const

/**
 * The French line 2 and line 3 leg.
 */
export const FR_UNIT_LINE_GUIDELINE_LEG: PostalGuidelineLeg = {
	country: "FR",
	locale: "fr-FR",
	rules: RULES,
	designators: RULES.flatMap((rule) => formsOf(rule.designator)),
	placeFromColumns(columns) {
		const postcode = columns[GEONAMES_POSTAL_COLUMNS.postcode]?.trim() ?? ""
		const locality = columns[GEONAMES_POSTAL_COLUMNS.place]?.trim() ?? ""

		if (!/^\d{5}$/u.test(postcode) || !isRenderablePlaceName(locality)) return null

		return { postcode, locality: locality.toUpperCase() }
	},
	render(random, place, pool) {
		const rule = sample(RULES, random)
		const form = sample(formsOf(rule.designator), random)
		const arrangement = sample(ARRANGEMENTS, random)
		const streetName = (drawOtherPlaceName(random, place, pool) ?? "l’eglise").toUpperCase()
		// A residence with the street's name would leave the aligner two equal spans.
		const residenceName = (drawOtherPlaceName(random, place, pool) ?? "jonquille").toUpperCase()

		const identifier = NAMED_DESIGNATORS.has(rule.designator)
			? residenceName === streetName
				? "JONQUILLE"
				: residenceName
			: drawUnitIdentifier(random, rule.kind === "building" ? 0.6 : 0.1)

		let houseNumber = drawBoxNumber(random, 1 + Math.floor(random() * 3))

		while (houseNumber === identifier) {
			houseNumber = drawBoxNumber(random, 3)
		}

		return {
			template: arrangement.template,
			ruleID: rule.id,
			...joinGuidelineLines(
				[
					[["unit", `${form} ${identifier}`]],
					[
						["house_number", houseNumber],
						["street", `RUE DE ${streetName}`],
					],
					[
						["postcode", place.postcode],
						["locality", place.locality],
					],
				],
				arrangement.separator
			),
		}
	},
}
