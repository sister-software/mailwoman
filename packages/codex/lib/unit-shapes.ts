/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Sub-premise identifiers that a postal system writes as a symbol shape rather than after a designator word.
 *
 *   Singapore and Malaysia write a unit as `#<floor>-<unit>`, so `#09-71` is unit 71 on the ninth floor. The
 *   United States writes `# 402` for a unit whose type is unstated. Each row records the countries whose
 *   operators publish its form, and rows are ordered most specific first, so `#09-71` matches the floor-unit
 *   row before the bare-hash row could take `#09` alone.
 */

/**
 * One symbol-shaped unit identifier.
 */
export interface UnitShape {
	label: string
	/**
	 * ISO 3166-1 alpha-2 codes of the countries whose postal operators publish this form.
	 */
	countries: readonly string[]
	/**
	 * The pattern source, matched with the `g` and `u` flags.
	 */
	pattern: string
	source: string
}

/**
 * Symbol-shaped unit identifiers, most specific first.
 */
export const UNIT_SHAPES: readonly UnitShape[] = [
	{
		label: "floor-unit",
		countries: ["SG", "MY"],
		pattern: String.raw`#\s?\d{1,3}-\d{1,4}[A-Za-z]?\b`,
		source: "SingPost addressing guide (`#01-38`); UPU Malaysia addressing sheet",
	},
	{
		label: "hash",
		countries: ["US"],
		pattern: String.raw`#\s*\d{1,5}[A-Za-z]?\b`,
		source: "https://pe.usps.com/text/pub28/28c2_003.htm USPS Publication 28, secondary address unit designators",
	},
]
