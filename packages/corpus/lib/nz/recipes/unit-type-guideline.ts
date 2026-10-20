/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The New Zealand leg of the `postal-unit-guideline` evaluation recipe, from NZ Post's
 *   {@linkcode NZ_UNIT_TYPE_RULES}: the Unit line (the Unit Type, then the Unit Identifier), the
 *   delivery line (street number and street), then the town and postcode.
 *
 *   The leg writes Kiosk, Shop, Villa and Flat, in full or abbreviated. Apartment, Room, Suite and
 *   Unit and their abbreviations Apt, Rm and Ste are Pub 28 designators that `spliced-unit` and
 *   `synthetic-secondary` write, so they are left out. The slash form on the delivery line
 *   (`2/153 Grange Road`) is left out for the reason the Australian leg gives: training writes a
 *   slashed flat number inside `house_number`.
 *
 *   The town is the GeoNames place name, and the street name is another held-out place's name with
 *   the cited example's `Road` or `Street`.
 */

import { NZ_UNIT_TYPE_RULES } from "@mailwoman/codex/nz"
import { sample } from "@mailwoman/core/random"
import { titleCase } from "spliterator/casing"

import { GEONAMES_POSTAL_COLUMNS } from "#adapters/geonames/postal/adapter"
import {
	drawBoxNumber,
	drawOtherPlaceName,
	drawUnitIdentifier,
	isRenderablePlaceName,
	joinGuidelineLines,
	type PostalGuidelineLeg,
} from "#recipes/postal-guideline/leg"

/**
 * The surface forms the leg writes, keyed by the Unit Type they write.
 */
const RENDERED_FORMS: Readonly<Record<string, readonly string[]>> = {
	Kiosk: ["Kiosk", "Ksk"],
	Shop: ["Shop", "Shp"],
	Villa: ["Villa", "Vlla"],
	Flat: ["Flat"],
}

const RULES = NZ_UNIT_TYPE_RULES.filter((rule) => rule.designator in RENDERED_FORMS)
const STREET_TYPES = ["Road", "Street"] as const

const ARRANGEMENTS = [
	{ template: "nz-unit:comma", separator: ", " },
	{ template: "nz-unit:space", separator: " " },
] as const

/**
 * The New Zealand Unit Type leg.
 */
export const NZ_UNIT_TYPE_GUIDELINE_LEG: PostalGuidelineLeg = {
	country: "NZ",
	locale: "en-NZ",
	rules: RULES,
	designators: Object.values(RENDERED_FORMS).flat(),
	placeFromColumns(columns) {
		const postcode = columns[GEONAMES_POSTAL_COLUMNS.postcode]?.trim() ?? ""
		const locality = columns[GEONAMES_POSTAL_COLUMNS.place]?.trim() ?? ""

		if (!/^\d{4}$/u.test(postcode) || !isRenderablePlaceName(locality)) return null

		return { postcode, locality }
	},
	render(random, place, pool) {
		const rule = sample(RULES, random)
		const form = sample(RENDERED_FORMS[rule.designator]!, random)
		const arrangement = sample(ARRANGEMENTS, random)
		const identifier = drawUnitIdentifier(random, 0.3)
		let houseNumber = drawBoxNumber(random, 1 + Math.floor(random() * 3))

		while (houseNumber === identifier) {
			houseNumber = drawBoxNumber(random, 3)
		}

		const name = titleCase(drawOtherPlaceName(random, place, pool) ?? "grange")

		return {
			template: arrangement.template,
			ruleID: rule.id,
			...joinGuidelineLines(
				[
					[["unit", `${form} ${identifier}`]],
					[
						["house_number", houseNumber],
						["street", `${name} ${sample(STREET_TYPES, random)}`],
					],
					[
						["locality", place.locality],
						["postcode", place.postcode],
					],
				],
				arrangement.separator
			),
		}
	},
}
