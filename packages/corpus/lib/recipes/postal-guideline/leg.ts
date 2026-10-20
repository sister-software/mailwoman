/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The shape of one country's leg of the `postal-guideline` evaluation recipe. Each leg lives under
 *   its country's directory and renders only the forms its codex rule table cites.
 */

import { formatAddressRow } from "@mailwoman/codex/address/format"
import type { ComponentDict } from "@mailwoman/codex/component"
import type { PoBoxGuidelineRule } from "@mailwoman/codex/postal-guideline"

/**
 * The longest GeoNames place name a leg writes, the same cap the `po-box-cedex` place readers apply.
 */
const MAX_PLACE_NAME_LENGTH = 40

/**
 * The place a rendered row names: one row of the GeoNames postal export.
 */
export interface PostalGuidelinePlace {
	locality: string
	postcode: string
	/**
	 * The region as the country's address line writes it, when it writes one.
	 */
	region?: string
}

/**
 * One rendered row before alignment.
 */
export interface PostalGuidelineRendering {
	/**
	 * The leg's name for the line arrangement it wrote.
	 */
	template: string
	/**
	 * The id of the cited rule the arrangement follows.
	 */
	ruleID: string
	raw: string
	components: Record<string, string>
}

/**
 * One country's leg.
 */
export interface PostalGuidelineLeg {
	/**
	 * ISO 3166-1 alpha-2 code.
	 * The leg reads the GeoNames postal export `<country>.txt`.
	 */
	country: string
	locale: string
	/**
	 * The cited rules the leg renders.
	 */
	rules: readonly PoBoxGuidelineRule[]
	/**
	 * Every designator surface form the leg writes, in the case it writes it.
	 */
	designators: readonly string[]
	/**
	 * Reads one GeoNames postal row, or returns null for a row the leg cannot render.
	 */
	placeFromColumns(columns: readonly string[]): PostalGuidelinePlace | null
	render(random: () => number, place: PostalGuidelinePlace): PostalGuidelineRendering
}

/**
 * Draws a box number of `digits` digits with no leading zero.
 */
export function drawBoxNumber(random: () => number, digits: number): string {
	const low = 10 ** (digits - 1)

	return String(low + Math.floor(random() * (9 * low)))
}

/**
 * Accepts a GeoNames place name for a one-line address: no digits, commas
 * or parentheses, and at most forty characters.
 */
export function isRenderablePlaceName(name: string): boolean {
	return name.length > 0 && name.length <= MAX_PLACE_NAME_LENGTH && !/[\d,()]/u.test(name)
}

/**
 * Writes a delivery-service line and the locality line in the country's codex layout,
 * joined by `separator`, and throws when the layout leaves a component out.
 */
export function renderGuidelineLine(
	country: string,
	components: Record<string, string>,
	separator: string
): Pick<PostalGuidelineRendering, "raw" | "components"> {
	const row = formatAddressRow(components as ComponentDict, country, { separator })

	if (!row || row.unplaced.length) {
		throw new Error(
			`postal-guideline: the ${country} layout did not place ${row ? row.unplaced.join(", ") : "any component"}.`
		)
	}

	return { raw: row.raw, components: row.components as Record<string, string> }
}
