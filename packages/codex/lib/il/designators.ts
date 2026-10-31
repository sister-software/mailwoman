/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Israeli postal designators in Hebrew: the premise, sub-premise, floor and relation words an address or a
 *   query uses.
 *
 * @see {@link https://he.wikipedia.org/wiki/תא_דואר Hebrew Wikipedia: תא דואר}
 * @see {@link https://en.wiktionary.org/wiki/קומה Wiktionary: קומה}
 * @see {@link https://en.wiktionary.org/wiki/דירה Wiktionary: דירה}
 * @see {@link https://en.wiktionary.org/wiki/כניסה Wiktionary: כניסה}
 * @see {@link https://en.wiktionary.org/wiki/ליד Wiktionary: ליד}
 * @see {@link https://en.wiktionary.org/wiki/מול Wiktionary: מול}
 */

import type { PostalDesignatorRow, PostalDesignatorTable } from "#postal/designator"

const WIKTIONARY = "https://en.wiktionary.org/wiki/"

const hebrew = { script: "Hebr", language: "he" } as const satisfies Pick<PostalDesignatorRow, "script" | "language">

/**
 * The designator rows for Israel, each carrying the published list it was read from.
 */
export const IL_POSTAL_DESIGNATORS: PostalDesignatorTable = {
	country: "IL",
	rows: [
		{
			...hebrew,
			spelling: "תא דואר",
			abbreviations: ["ת.ד.", "ת״ד"],
			position: "prefix",
			concept: "post_office_box",
			source: "https://he.wikipedia.org/wiki/תא_דואר",
		},
		{
			...hebrew,
			spelling: "כניסה",
			abbreviations: [],
			position: "prefix",
			concept: "entrance",
			source: `${WIKTIONARY}כניסה`,
		},
		{
			...hebrew,
			spelling: "דירה",
			abbreviations: [],
			position: "prefix",
			concept: "apartment",
			source: `${WIKTIONARY}דירה`,
		},
		{
			...hebrew,
			spelling: "קומה",
			abbreviations: [],
			position: "prefix",
			concept: "floor",
			source: `${WIKTIONARY}קומה`,
		},
		{
			...hebrew,
			spelling: "ליד",
			abbreviations: [],
			position: "prefix",
			concept: "near",
			source: `${WIKTIONARY}ליד`,
		},
		{
			...hebrew,
			spelling: "ליד",
			abbreviations: [],
			position: "prefix",
			concept: "beside",
			source: `${WIKTIONARY}ליד`,
		},
		{
			...hebrew,
			spelling: "לידי",
			abbreviations: [],
			position: "standalone",
			concept: "near_asker",
			source: `${WIKTIONARY}ליד`,
		},
		{
			...hebrew,
			spelling: "מול",
			abbreviations: [],
			position: "prefix",
			concept: "opposite",
			source: `${WIKTIONARY}מול`,
		},
	],
}
