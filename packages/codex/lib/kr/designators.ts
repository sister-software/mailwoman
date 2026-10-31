/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   South Korea designators in Hangul: the delivery service, premise, sub-premise, floor and relation words
 *   that a Korean address or query uses.
 *
 * @see {@link https://www.upu.int/UPU/media/upu/PostalEntitiesFiles/addressingUnit/korEn.pdf UPU Korea addressing profile}
 * @see {@link https://en.wiktionary.org/wiki/사서함 Wiktionary 사서함}
 * @see {@link https://en.wiktionary.org/wiki/동 Wiktionary 동}
 * @see {@link https://en.wiktionary.org/wiki/건물 Wiktionary 건물}
 * @see {@link https://en.wiktionary.org/wiki/호 Wiktionary 호}
 * @see {@link https://en.wiktionary.org/wiki/층 Wiktionary 층}
 * @see {@link https://en.wiktionary.org/wiki/지하 Wiktionary 지하}
 * @see {@link https://en.wiktionary.org/wiki/옥상 Wiktionary 옥상}
 * @see {@link https://en.wiktionary.org/wiki/근처 Wiktionary 근처}
 * @see {@link https://en.wiktionary.org/wiki/옆 Wiktionary 옆}
 * @see {@link https://en.wiktionary.org/wiki/맞은편 Wiktionary 맞은편}
 * @see {@link https://en.wiktionary.org/wiki/내 Wiktionary 내}
 */

import type { PostalDesignatorTable } from "#postal/designator"

const UPU_KOREA = "https://www.upu.int/UPU/media/upu/PostalEntitiesFiles/addressingUnit/korEn.pdf"
const WIKTIONARY = "https://en.wiktionary.org/wiki/"

/**
 * South Korea's designator rows, each carrying the published list it was checked against.
 */
export const KR_POSTAL_DESIGNATORS: PostalDesignatorTable = {
	country: "KR",
	rows: [
		{
			spelling: "사서함",
			abbreviations: [],
			script: "Kore",
			position: "prefix",
			concept: "post_office_box",
			language: "ko",
			source: `${WIKTIONARY}사서함`,
		},
		{
			spelling: "동",
			abbreviations: [],
			script: "Kore",
			position: "suffix",
			concept: "building",
			language: "ko",
			source: UPU_KOREA,
		},
		{
			spelling: "건물",
			abbreviations: [],
			script: "Kore",
			position: "suffix",
			concept: "building",
			language: "ko",
			source: `${WIKTIONARY}건물`,
		},
		{
			spelling: "호",
			abbreviations: [],
			script: "Kore",
			position: "suffix",
			concept: "unit",
			language: "ko",
			source: UPU_KOREA,
		},
		{
			spelling: "층",
			abbreviations: [],
			script: "Kore",
			position: "suffix",
			concept: "floor",
			language: "ko",
			source: UPU_KOREA,
		},
		{
			spelling: "지하",
			abbreviations: [],
			script: "Kore",
			position: "prefix",
			concept: "basement",
			language: "ko",
			source: UPU_KOREA,
		},
		{
			spelling: "옥상",
			abbreviations: [],
			script: "Kore",
			position: "standalone",
			concept: "rooftop",
			language: "ko",
			source: `${WIKTIONARY}옥상`,
		},
		{
			spelling: "근처",
			abbreviations: [],
			script: "Kore",
			position: "suffix",
			concept: "near",
			language: "ko",
			source: `${WIKTIONARY}근처`,
		},
		{
			spelling: "옆",
			abbreviations: [],
			script: "Kore",
			position: "suffix",
			concept: "beside",
			language: "ko",
			source: `${WIKTIONARY}옆`,
		},
		{
			spelling: "맞은편",
			abbreviations: [],
			script: "Kore",
			position: "suffix",
			concept: "opposite",
			language: "ko",
			source: `${WIKTIONARY}맞은편`,
		},
		{
			spelling: "내 근처",
			abbreviations: [],
			script: "Kore",
			position: "standalone",
			concept: "near_asker",
			language: "ko",
			source: `composed from the near row and the first-person pronoun (Wiktionary ${WIKTIONARY}내)`,
		},
	],
}
