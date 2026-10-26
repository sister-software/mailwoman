/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Taiwan designators in Traditional Chinese: the delivery service, premise, sub-premise, floor and relation
 *   words that a Taiwanese address or query uses.
 *
 * @see {@link https://en.wiktionary.org/wiki/郵政信箱 Wiktionary 郵政信箱}
 * @see {@link https://en.wiktionary.org/wiki/信箱 Wiktionary 信箱}
 * @see {@link https://en.wiktionary.org/wiki/棟 Wiktionary 棟}
 * @see {@link https://en.wiktionary.org/wiki/大樓 Wiktionary 大樓}
 * @see {@link https://en.wiktionary.org/wiki/室 Wiktionary 室}
 * @see {@link https://en.wiktionary.org/wiki/號 Wiktionary 號}
 * @see {@link https://en.wiktionary.org/wiki/樓 Wiktionary 樓}
 * @see {@link https://en.wiktionary.org/wiki/樓層 Wiktionary 樓層}
 * @see {@link https://en.wiktionary.org/wiki/地下 Wiktionary 地下}
 * @see {@link https://en.wiktionary.org/wiki/地下室 Wiktionary 地下室}
 * @see {@link https://en.wiktionary.org/wiki/頂樓 Wiktionary 頂樓}
 * @see {@link https://en.wiktionary.org/wiki/附近 Wiktionary 附近}
 * @see {@link https://en.wiktionary.org/wiki/旁边 Wiktionary 旁边}
 * @see {@link https://en.wiktionary.org/wiki/对面 Wiktionary 对面}
 * @see {@link https://en.wiktionary.org/wiki/roof Wiktionary roof (translations)}
 * @see {@link https://en.wiktionary.org/wiki/我 Wiktionary 我}
 */

import type { PostalDesignatorTable } from "#postal-designator"

const WIKTIONARY = "https://en.wiktionary.org/wiki/"

/**
 * Taiwan's designator rows, each carrying the published list it was checked against.
 */
export const TW_POSTAL_DESIGNATORS: PostalDesignatorTable = {
	country: "TW",
	rows: [
		{
			spelling: "郵政信箱",
			abbreviations: ["信箱"],
			script: "Hant",
			position: "prefix",
			concept: "post_office_box",
			language: "zh",
			source: `${WIKTIONARY}郵政信箱`,
		},
		{
			spelling: "棟",
			abbreviations: [],
			script: "Hant",
			position: "suffix",
			concept: "building",
			language: "zh",
			source: `${WIKTIONARY}棟`,
		},
		{
			spelling: "大樓",
			abbreviations: [],
			script: "Hant",
			position: "suffix",
			concept: "building",
			language: "zh",
			source: `${WIKTIONARY}大樓`,
		},
		{
			spelling: "室",
			abbreviations: [],
			script: "Hant",
			position: "suffix",
			concept: "room",
			language: "zh",
			source: `${WIKTIONARY}室`,
		},
		{
			spelling: "號",
			abbreviations: [],
			script: "Hant",
			position: "suffix",
			concept: "number_sign",
			language: "zh",
			source: `${WIKTIONARY}號`,
		},
		{
			spelling: "樓",
			abbreviations: [],
			script: "Hant",
			position: "suffix",
			concept: "floor",
			language: "zh",
			source: `${WIKTIONARY}樓`,
		},
		{
			spelling: "樓層",
			abbreviations: [],
			script: "Hant",
			position: "suffix",
			concept: "floor",
			language: "zh",
			source: `${WIKTIONARY}樓層`,
		},
		{
			spelling: "地下",
			abbreviations: [],
			script: "Hant",
			position: "prefix",
			concept: "basement",
			language: "zh",
			source: `${WIKTIONARY}地下`,
		},
		{
			spelling: "地下室",
			abbreviations: [],
			script: "Hant",
			position: "standalone",
			concept: "basement",
			language: "zh",
			source: `${WIKTIONARY}地下室`,
		},
		{
			spelling: "頂樓",
			abbreviations: [],
			script: "Hant",
			position: "standalone",
			concept: "penthouse",
			language: "zh",
			source: `${WIKTIONARY}頂樓`,
		},
		{
			spelling: "附近",
			abbreviations: [],
			script: "Hant",
			position: "suffix",
			concept: "near",
			language: "zh",
			source: `${WIKTIONARY}附近`,
		},
		{
			spelling: "旁邊",
			abbreviations: [],
			script: "Hant",
			position: "suffix",
			concept: "beside",
			language: "zh",
			source: `${WIKTIONARY}旁边`,
		},
		{
			spelling: "對面",
			abbreviations: [],
			script: "Hant",
			position: "suffix",
			concept: "opposite",
			language: "zh",
			source: `${WIKTIONARY}对面`,
		},
		{
			spelling: "屋頂",
			abbreviations: [],
			script: "Hant",
			position: "standalone",
			concept: "rooftop",
			language: "zh",
			source: `${WIKTIONARY}roof#Translations`,
		},
		{
			spelling: "我附近",
			abbreviations: [],
			script: "Hant",
			position: "standalone",
			concept: "near_asker",
			language: "zh",
			source: `composed from the near row and the first-person pronoun (Wiktionary ${WIKTIONARY}我)`,
		},
	],
}
