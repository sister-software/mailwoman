/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The towns whose own name carries the city marker 市 (shi) before the town suffix 町 / 村 (chō / son).
 *
 *   A Japanese municipality span closes at 市 in the ordinary case (`富山市`, `神戸市西区`), and a character model
 *   learns that boundary from 1,700 cities. A town whose NAME contains 市 defeats it: `中新川郡上市町` reads as the
 *   city `上市` plus a district beginning with 町. Over the 1,892 municipalities in Japan Post's KEN_ALL list the
 *   shape has six members, so the boundary is stated here rather than learned — a positive attestation from the
 *   postal register, consumed after decode by `@mailwoman/neural`'s JP municipality repair. Two of the six (`上市町`,
 *   `下市町`) put 市 immediately before the suffix, the boundary the model closes at; the other four are listed for the same
 *   repair so an early close inside them is also repaired.
 */

/**
 * One town from Japan Post's KEN_ALL municipality list whose own name contains 市.
 */
export interface JapaneseInnerShiTown {
	/**
	 * The prefecture, as written (`富山県`).
	 */
	prefecture: string
	/**
	 * The county (郡) the town belongs to, as the postal form writes it before the town.
	 */
	county: string
	/**
	 * The town's own name with its suffix (`上市町`).
	 */
	town: string
}

/**
 * The six towns, from KEN_ALL (1,892 municipalities). Ordered by prefecture code.
 */
export const JP_INNER_SHI_TOWNS: readonly JapaneseInnerShiTown[] = [
	{ prefecture: "北海道", county: "余市郡", town: "余市町" },
	{ prefecture: "栃木県", county: "芳賀郡", town: "市貝町" },
	{ prefecture: "富山県", county: "中新川郡", town: "上市町" },
	{ prefecture: "山梨県", county: "西八代郡", town: "市川三郷町" },
	{ prefecture: "奈良県", county: "吉野郡", town: "下市町" },
	{ prefecture: "兵庫県", county: "神崎郡", town: "市川町" },
]

/**
 * Every surface a municipality span may legitimately close on for these towns: the postal form with the county
 * (`中新川郡上市町`) and the bare town (`上市町`).
 */
export const JP_INNER_SHI_TOWN_NAMES: readonly string[] = JP_INNER_SHI_TOWNS.flatMap((t) => [t.county + t.town, t.town])

/**
 * The characters a municipality surface must absorb from what follows it to become one of the register's names, or null
 * when no name extends it. `following` is the text after the surface; the answer is a prefix of it. A surface that
 * already IS a register name answers null: nothing to absorb.
 */
export function jpMunicipalityCompletion(surface: string, following: string): string | null {
	for (const name of JP_INNER_SHI_TOWN_NAMES) {
		if (name.length > surface.length && name.startsWith(surface)) {
			const remainder = name.slice(surface.length)

			if (following.startsWith(remainder)) return remainder
		}
	}

	return null
}
