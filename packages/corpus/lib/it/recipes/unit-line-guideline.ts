/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The Italian leg of the `postal-unit-guideline` evaluation recipe, from Poste Italiane's
 *   {@linkcode IT_UNIT_LINE_RULES}: the third line gives the staircase, the floor and the door in
 *   that order (`scala B piano 2 interno 7`), the fourth the street and civic number, and the fifth
 *   the CAP, the locality and the province abbreviation.
 *
 *   Each row writes one, two or all three of the words, in the document's order, as one `unit` span.
 *   The document writes them in lower case, and the leg also writes them capitalized. The street is
 *   `Via` and another held-out place's name, the noun the document's own line-four template uses.
 */

import { IT_UNIT_LINE_RULES } from "@mailwoman/codex/it"
import { sample } from "@mailwoman/core/random"
import { titleCase } from "spliterator/casing"

import { IT_CASELLA_POSTALE_GUIDELINE_LEG } from "#it/recipes/casella-postale-guideline"
import {
	drawBoxNumber,
	drawOtherPlaceName,
	drawUnitIdentifier,
	joinGuidelineLines,
	type PostalGuidelineLeg,
} from "#recipes/postal/guideline/leg"

/**
 * The chance that a row writes each of the three words, drawn independently.
 *
 * A row that draws none writes one at random.
 * The value is this repository's choice, and the document states no share.
 */
const WORD_SHARE = 0.6

const ARRANGEMENTS = [
	{ template: "it-unit-line:comma", separator: ", " },
	{ template: "it-unit-line:space", separator: " " },
] as const

/**
 * The Italian building-line leg.
 */
export const IT_UNIT_LINE_GUIDELINE_LEG: PostalGuidelineLeg = {
	country: "IT",
	locale: "it-IT",
	rules: IT_UNIT_LINE_RULES,
	designators: IT_UNIT_LINE_RULES.flatMap((rule) => [rule.designator, titleCase(rule.designator)]),
	placeFromColumns: IT_CASELLA_POSTALE_GUIDELINE_LEG.placeFromColumns,
	render(random, place, pool) {
		const capitalized = random() < 0.5
		const chosen = IT_UNIT_LINE_RULES.filter(() => random() < WORD_SHARE)
		const rules = chosen.length ? chosen : [sample(IT_UNIT_LINE_RULES, random)]

		const unit = rules
			.map((rule) => {
				const word = capitalized ? titleCase(rule.designator) : rule.designator
				const identifier = drawUnitIdentifier(random, rule.kind === "staircase" ? 0.7 : 0)

				return `${word} ${identifier}`
			})
			.join(" ")

		const arrangement = sample(ARRANGEMENTS, random)
		const name = titleCase(drawOtherPlaceName(random, place, pool) ?? "roma")
		let houseNumber = drawBoxNumber(random, 1 + Math.floor(random() * 3))

		while (unit.endsWith(` ${houseNumber}`)) {
			houseNumber = drawBoxNumber(random, 3)
		}

		return {
			template: arrangement.template,
			ruleID: rules[0]!.id,
			...joinGuidelineLines(
				[
					[["unit", unit]],
					[
						["street", `Via ${name}`],
						["house_number", houseNumber],
					],
					[
						["postcode", place.postcode],
						["locality", place.locality],
						["region", place.region!],
					],
				],
				arrangement.separator
			),
		}
	},
}
