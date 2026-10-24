/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The shape of one country's leg of the `postal-guideline` evaluation recipe. Each leg lives under
 *   its country's directory and renders only the forms its codex rule table cites.
 */

import { formatAddressRow } from "@mailwoman/codex/address/format"
import type { ComponentDict } from "@mailwoman/codex/address/render"
import type { PostalGuidelineRule } from "@mailwoman/codex/postal-guideline"

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
	rules: readonly PostalGuidelineRule[]
	/**
	 * Every designator surface form the leg writes, in the case it writes it.
	 */
	designators: readonly string[]
	/**
	 * Reads one GeoNames postal row, or returns null for a row the leg cannot render.
	 */
	placeFromColumns(columns: readonly string[]): PostalGuidelinePlace | null
	/**
	 * Renders one row naming `place`.
	 *
	 * @param pool - The places of the leg's country on the same side of the split's holdout
	 * as `place`, from which a leg may draw a name for a street or a residence.
	 */
	render(
		random: () => number,
		place: PostalGuidelinePlace,
		pool: readonly PostalGuidelinePlace[]
	): PostalGuidelineRendering
}

/**
 * One component on a guideline line: its tag and the text written for it.
 */
export type GuidelinePart = readonly [tag: string, text: string]

/**
 * Writes cited address lines in the order given, the parts of a line joined by a space
 * and the lines joined by `separator`, and throws when a tag repeats.
 */
export function joinGuidelineLines(
	lines: ReadonlyArray<readonly GuidelinePart[]>,
	separator: string
): Pick<PostalGuidelineRendering, "raw" | "components"> {
	const components: Record<string, string> = {}

	for (const [tag, text] of lines.flat()) {
		if (tag in components) throw new Error(`postal-guideline: the lines write ${tag} twice.`)

		components[tag] = text
	}

	return { raw: lines.map((line) => line.map(([, text]) => text).join(" ")).join(separator), components }
}

/**
 * Draws {@link drawOtherPlaceName} makes before it gives up.
 *
 * A pool that yields no distinct name in twenty draws leaves the leg's fallback name in place.
 */
const OTHER_PLACE_ATTEMPTS = 20

/**
 * Draws a held-out place name, other than the row's own locality and sharing no
 * substring with it either way, for a street or residence name.
 * Returns null when the pool holds no such name.
 */
export function drawOtherPlaceName(
	random: () => number,
	place: PostalGuidelinePlace,
	pool: readonly PostalGuidelinePlace[]
): string | null {
	const own = place.locality.toLowerCase()

	for (let attempt = 0; attempt < OTHER_PLACE_ATTEMPTS; attempt++) {
		const other = pool[Math.floor(random() * pool.length)]?.locality.toLowerCase()

		if (other && !other.includes(own) && !own.includes(other)) return other
	}

	return null
}

/**
 * Draws a box number of `digits` digits with no leading zero.
 */
export function drawBoxNumber(random: () => number, digits: number): string {
	const low = 10 ** (digits - 1)

	return String(low + Math.floor(random() * (9 * low)))
}

/**
 * Draws a unit identifier: a number of one or two digits with no leading zero, or,
 * when `letterShare` allows, one capital letter from A to H.
 */
export function drawUnitIdentifier(random: () => number, letterShare: number): string {
	if (random() < letterShare) return String.fromCharCode(65 + Math.floor(random() * 8))

	return drawBoxNumber(random, 1 + Math.floor(random() * 2))
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
