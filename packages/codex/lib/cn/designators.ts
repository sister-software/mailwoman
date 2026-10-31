/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   China designators in Simplified Chinese: the delivery service, premise, sub-premise, floor and relation
 *   words that a mainland address or query uses.
 *
 * @see {@link https://www.upu.int/UPU/media/upu/PostalEntitiesFiles/addressingUnit/chnEn.pdf UPU China addressing profile}
 * @see {@link https://en.wiktionary.org/wiki/邮政信箱 Wiktionary 邮政信箱}
 * @see {@link https://en.wiktionary.org/wiki/信箱 Wiktionary 信箱}
 * @see {@link https://en.wiktionary.org/wiki/栋 Wiktionary 栋}
 * @see {@link https://en.wiktionary.org/wiki/幢 Wiktionary 幢}
 * @see {@link https://en.wiktionary.org/wiki/樓 Wiktionary 樓}
 * @see {@link https://en.wiktionary.org/wiki/室 Wiktionary 室}
 * @see {@link https://en.wiktionary.org/wiki/房 Wiktionary 房}
 * @see {@link https://en.wiktionary.org/wiki/附近 Wiktionary 附近}
 * @see {@link https://en.wiktionary.org/wiki/旁边 Wiktionary 旁边}
 * @see {@link https://en.wiktionary.org/wiki/对面 Wiktionary 对面}
 * @see {@link https://zh.wikipedia.org/zh-cn/地址 Chinese Wikipedia 地址}
 * @see {@link https://en.wiktionary.org/wiki/roof Wiktionary roof (translations)}
 * @see {@link https://en.wiktionary.org/wiki/basement Wiktionary basement (translations)}
 * @see {@link https://en.wiktionary.org/wiki/我 Wiktionary 我}
 */

import type { PostalDesignatorTable } from "#postal/designator"

const UPU_CHINA = "https://www.upu.int/UPU/media/upu/PostalEntitiesFiles/addressingUnit/chnEn.pdf"
const WIKTIONARY = "https://en.wiktionary.org/wiki/"
const ZH_WIKIPEDIA_ADDRESS = "https://zh.wikipedia.org/zh-cn/地址"

/**
 * China's designator rows, each carrying the published list it was checked against.
 */
export const CN_POSTAL_DESIGNATORS: PostalDesignatorTable = {
	country: "CN",
	rows: [
		{
			spelling: "邮政信箱",
			abbreviations: ["信箱"],
			script: "Hans",
			position: "prefix",
			concept: "post_office_box",
			language: "zh",
			source: UPU_CHINA,
		},
		{
			spelling: "栋",
			abbreviations: [],
			script: "Hans",
			position: "suffix",
			concept: "building",
			language: "zh",
			source: `${WIKTIONARY}栋`,
		},
		{
			spelling: "幢",
			abbreviations: [],
			script: "Hans",
			position: "suffix",
			concept: "building",
			language: "zh",
			source: `${WIKTIONARY}幢`,
		},
		{
			spelling: "室",
			abbreviations: [],
			script: "Hans",
			position: "suffix",
			concept: "room",
			language: "zh",
			source: UPU_CHINA,
		},
		{
			spelling: "房",
			abbreviations: [],
			script: "Hans",
			position: "suffix",
			concept: "room",
			language: "zh",
			source: `${WIKTIONARY}房`,
		},
		{
			spelling: "层",
			abbreviations: [],
			script: "Hans",
			position: "suffix",
			concept: "floor",
			language: "zh",
			source: UPU_CHINA,
		},
		{
			spelling: "楼",
			abbreviations: [],
			script: "Hans",
			position: "suffix",
			concept: "floor",
			language: "zh",
			source: `${WIKTIONARY}樓`,
		},
		{
			spelling: "附近",
			abbreviations: [],
			script: "Hans",
			position: "suffix",
			concept: "near",
			language: "zh",
			source: `${WIKTIONARY}附近`,
		},
		{
			spelling: "旁边",
			abbreviations: [],
			script: "Hans",
			position: "suffix",
			concept: "beside",
			language: "zh",
			source: `${WIKTIONARY}旁边`,
		},
		{
			spelling: "对面",
			abbreviations: [],
			script: "Hans",
			position: "suffix",
			concept: "opposite",
			language: "zh",
			source: `${WIKTIONARY}对面`,
		},
		{
			spelling: "单元",
			abbreviations: [],
			script: "Hans",
			position: "suffix",
			concept: "unit",
			language: "zh",
			source: ZH_WIKIPEDIA_ADDRESS,
		},
		{
			spelling: "屋顶",
			abbreviations: [],
			script: "Hans",
			position: "standalone",
			concept: "rooftop",
			language: "zh",
			source: `${WIKTIONARY}roof#Translations`,
		},
		{
			spelling: "地下室",
			abbreviations: [],
			script: "Hans",
			position: "standalone",
			concept: "basement",
			language: "zh",
			source: `${WIKTIONARY}basement#Translations`,
		},
		{
			spelling: "我附近",
			abbreviations: [],
			script: "Hans",
			position: "standalone",
			concept: "near_asker",
			language: "zh",
			source: `composed from the near row and the first-person pronoun (Wiktionary ${WIKTIONARY}我)`,
		},
	],
}
