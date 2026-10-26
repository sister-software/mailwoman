/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Hong Kong designators in English and Traditional Chinese: the delivery service, premise, sub-premise, floor
 *   and relation words that a Hong Kong address or query uses. Floor codes follow the Land Registry list.
 *
 * @see {@link https://www.upu.int/UPU/media/upu/PostalEntitiesFiles/addressingUnit/hkgEn.pdf UPU Hongkong addressing profile}
 * @see {@link https://www1.iris.gov.hk/eservices/help/topic02.jsp Land Registry list of commonly used floor codes}
 * @see {@link https://en.wiktionary.org/wiki/大廈 Wiktionary 大廈}
 * @see {@link https://en.wiktionary.org/wiki/座 Wiktionary 座}
 * @see {@link https://en.wiktionary.org/wiki/樓 Wiktionary 樓}
 * @see {@link https://en.wiktionary.org/wiki/附近 Wiktionary 附近}
 * @see {@link https://en.wiktionary.org/wiki/旁边 Wiktionary 旁边}
 * @see {@link https://en.wiktionary.org/wiki/对面 Wiktionary 对面}
 * @see {@link https://zh.wikipedia.org/zh-hk/地址 Chinese Wikipedia 地址}
 * @see {@link https://en.wiktionary.org/wiki/我 Wiktionary 我}
 */

import type { PostalDesignatorTable } from "#postal-designator"

const UPU_HONG_KONG = "https://www.upu.int/UPU/media/upu/PostalEntitiesFiles/addressingUnit/hkgEn.pdf"
const LAND_REGISTRY_FLOOR_CODES = "https://www1.iris.gov.hk/eservices/help/topic02.jsp"
const WIKTIONARY = "https://en.wiktionary.org/wiki/"

/**
 * Hong Kong's designator rows, each carrying the published list it was checked against.
 */
export const HK_POSTAL_DESIGNATORS: PostalDesignatorTable = {
	country: "HK",
	rows: [
		{
			spelling: "P.O. Box",
			abbreviations: ["PO Box"],
			script: "Latn",
			position: "prefix",
			concept: "post_office_box",
			language: "en",
			source: UPU_HONG_KONG,
		},
		{
			spelling: "Building",
			abbreviations: [],
			script: "Latn",
			position: "suffix",
			concept: "building",
			language: "en",
			source: UPU_HONG_KONG,
		},
		{
			spelling: "大廈",
			abbreviations: [],
			script: "Hant",
			position: "suffix",
			concept: "building",
			language: "zh",
			source: `${WIKTIONARY}大廈`,
		},
		{
			spelling: "座",
			abbreviations: [],
			script: "Hant",
			position: "suffix",
			concept: "block",
			language: "zh",
			source: `${WIKTIONARY}座`,
		},
		{
			spelling: "Flat",
			abbreviations: [],
			script: "Latn",
			position: "prefix",
			concept: "apartment",
			language: "en",
			source: UPU_HONG_KONG,
		},
		{
			spelling: "/F",
			abbreviations: ["F"],
			script: "Latn",
			position: "suffix",
			concept: "floor",
			language: "en",
			source: UPU_HONG_KONG,
		},
		{
			// The ground floor in the same `<level>/F` form as `12/F`.
			spelling: "G/F",
			abbreviations: [],
			script: "Latn",
			position: "standalone",
			concept: "ground_floor",
			language: "en",
			source: UPU_HONG_KONG,
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
			spelling: "LG",
			abbreviations: [],
			script: "Latn",
			position: "standalone",
			concept: "ground_floor",
			language: "en",
			source: LAND_REGISTRY_FLOOR_CODES,
		},
		{
			spelling: "M",
			abbreviations: [],
			script: "Latn",
			position: "standalone",
			concept: "mezzanine",
			language: "en",
			source: LAND_REGISTRY_FLOOR_CODES,
		},
		{
			spelling: "R",
			abbreviations: [],
			script: "Latn",
			position: "standalone",
			concept: "rooftop",
			language: "en",
			source: LAND_REGISTRY_FLOOR_CODES,
		},
		{
			spelling: "LR",
			abbreviations: [],
			script: "Latn",
			position: "standalone",
			concept: "rooftop",
			language: "en",
			source: LAND_REGISTRY_FLOOR_CODES,
		},
		{
			spelling: "UR",
			abbreviations: [],
			script: "Latn",
			position: "standalone",
			concept: "rooftop",
			language: "en",
			source: LAND_REGISTRY_FLOOR_CODES,
		},
		{
			spelling: "MR",
			abbreviations: [],
			script: "Latn",
			position: "standalone",
			concept: "rooftop",
			language: "en",
			source: LAND_REGISTRY_FLOOR_CODES,
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
			spelling: "室",
			abbreviations: [],
			script: "Hant",
			position: "suffix",
			concept: "room",
			language: "zh",
			source: "https://zh.wikipedia.org/zh-hk/地址",
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
