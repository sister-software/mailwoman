/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Singapore designators in English, Chinese and Malay: the block, the `#floor-unit` number and the relation
 *   words that a Singapore address or query uses.
 *
 * @see {@link https://www.upu.int/UPU/media/upu/PostalEntitiesFiles/addressingUnit/sgpEn.pdf UPU Singapore addressing profile}
 * @see {@link https://en.wiktionary.org/wiki/附近 Wiktionary 附近}
 * @see {@link https://en.wiktionary.org/wiki/旁边 Wiktionary 旁边}
 * @see {@link https://en.wiktionary.org/wiki/对面 Wiktionary 对面}
 * @see {@link https://en.wiktionary.org/wiki/dekat Wiktionary dekat}
 * @see {@link https://en.wiktionary.org/wiki/post_office_box Wiktionary post office box (translations)}
 * @see {@link https://en.wiktionary.org/wiki/near Wiktionary near (translations)}
 * @see {@link https://en.wiktionary.org/wiki/me Wiktionary me}
 * @see {@link https://en.wiktionary.org/wiki/我 Wiktionary 我}
 * @see {@link https://en.wiktionary.org/wiki/saya Wiktionary saya}
 */

import type { PostalDesignatorTable } from "#postal-designator"

const UPU_SINGAPORE = "https://www.upu.int/UPU/media/upu/PostalEntitiesFiles/addressingUnit/sgpEn.pdf"
const WIKTIONARY = "https://en.wiktionary.org/wiki/"

/**
 * Singapore's designator rows, each carrying the published list it was checked against.
 */
export const SG_POSTAL_DESIGNATORS: PostalDesignatorTable = {
	country: "SG",
	rows: [
		{
			spelling: "Blk",
			abbreviations: ["Block"],
			script: "Latn",
			position: "prefix",
			concept: "block",
			language: "en",
			source: UPU_SINGAPORE,
		},
		{
			spelling: "#",
			abbreviations: [],
			script: "Latn",
			position: "prefix",
			concept: "unit",
			language: "en",
			source: UPU_SINGAPORE,
		},
		{
			spelling: "-",
			abbreviations: ["–"],
			script: "Latn",
			position: "infix",
			concept: "unit",
			language: "en",
			source: UPU_SINGAPORE,
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
			spelling: "dekat",
			abbreviations: [],
			script: "Latn",
			position: "prefix",
			concept: "near",
			language: "ms",
			source: `${WIKTIONARY}dekat`,
		},
		{
			spelling: "邮政信箱",
			abbreviations: [],
			script: "Hans",
			position: "prefix",
			concept: "post_office_box",
			language: "zh",
			source: `${WIKTIONARY}post_office_box#Translations`,
		},
		{
			spelling: "near",
			abbreviations: [],
			script: "Latn",
			position: "prefix",
			concept: "near",
			language: "en",
			source: `${WIKTIONARY}near#Translations`,
		},
		{
			spelling: "near me",
			abbreviations: [],
			script: "Latn",
			position: "standalone",
			concept: "near_asker",
			language: "en",
			source: `composed from the near row and the first-person pronoun (Wiktionary ${WIKTIONARY}me)`,
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
		{
			spelling: "dekat saya",
			abbreviations: [],
			script: "Latn",
			position: "standalone",
			concept: "near_asker",
			language: "ms",
			source: `composed from the near row and the first-person pronoun (Wiktionary ${WIKTIONARY}saya)`,
		},
	],
}
