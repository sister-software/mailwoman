/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Indonesia designators in Indonesian: the delivery service, premise, floor and relation words that an
 *   Indonesian address or query uses.
 *
 * @see {@link https://www.upu.int/UPU/media/upu/PostalEntitiesFiles/addressingUnit/idnEn.pdf UPU Indonesia addressing profile}
 * @see {@link https://en.wiktionary.org/wiki/menara Wiktionary menara}
 * @see {@link https://en.wiktionary.org/wiki/tingkat Wiktionary tingkat}
 * @see {@link https://en.wiktionary.org/wiki/dekat Wiktionary dekat}
 * @see {@link https://en.wiktionary.org/wiki/post_office_box Wiktionary post office box (translations)}
 * @see {@link https://en.wiktionary.org/wiki/saya Wiktionary saya}
 */

import type { PostalDesignatorTable } from "#postal/designator"

const UPU_INDONESIA = "https://www.upu.int/UPU/media/upu/PostalEntitiesFiles/addressingUnit/idnEn.pdf"
const WIKTIONARY = "https://en.wiktionary.org/wiki/"

/**
 * Indonesia's designator rows, each carrying the published list it was checked against.
 */
export const ID_POSTAL_DESIGNATORS: PostalDesignatorTable = {
	country: "ID",
	rows: [
		{
			spelling: "PO Box",
			abbreviations: ["P.O. Box"],
			script: "Latn",
			position: "prefix",
			concept: "post_office_box",
			language: "id",
			source: UPU_INDONESIA,
		},
		{
			spelling: "Building",
			abbreviations: ["Bldg"],
			script: "Latn",
			position: "suffix",
			concept: "building",
			language: "en",
			source: UPU_INDONESIA,
		},
		{
			spelling: "Menara",
			abbreviations: [],
			script: "Latn",
			position: "prefix",
			concept: "tower",
			language: "id",
			source: `${WIKTIONARY}menara`,
		},
		{
			spelling: "Floor",
			abbreviations: [],
			script: "Latn",
			position: "suffix",
			concept: "floor",
			language: "en",
			source: UPU_INDONESIA,
		},
		{
			spelling: "Tingkat",
			abbreviations: [],
			script: "Latn",
			position: "prefix",
			concept: "floor",
			language: "id",
			source: `${WIKTIONARY}tingkat`,
		},
		{
			spelling: "dekat",
			abbreviations: [],
			script: "Latn",
			position: "prefix",
			concept: "near",
			language: "id",
			source: `${WIKTIONARY}dekat`,
		},
		{
			spelling: "Kotak Pos",
			abbreviations: [],
			script: "Latn",
			position: "prefix",
			concept: "post_office_box",
			language: "id",
			source: `${WIKTIONARY}post_office_box#Translations`,
		},
		{
			spelling: "dekat saya",
			abbreviations: [],
			script: "Latn",
			position: "standalone",
			concept: "near_asker",
			language: "id",
			source: `composed from the near row and the first-person pronoun (Wiktionary ${WIKTIONARY}saya)`,
		},
	],
}
