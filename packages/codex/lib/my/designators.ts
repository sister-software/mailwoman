/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Malaysia designators in Malay: the delivery service, premise, floor and relation words that a Malaysian
 *   address or query uses.
 *
 * @see {@link https://www.upu.int/UPU/media/upu/PostalEntitiesFiles/addressingUnit/mysEn.pdf UPU Malaysia addressing profile}
 * @see {@link https://en.wiktionary.org/wiki/menara Wiktionary menara}
 * @see {@link https://en.wiktionary.org/wiki/tingkat Wiktionary tingkat}
 * @see {@link https://en.wiktionary.org/wiki/dekat Wiktionary dekat}
 * @see {@link https://en.wiktionary.org/wiki/near Wiktionary near (translations)}
 * @see {@link https://en.wiktionary.org/wiki/me Wiktionary me}
 * @see {@link https://en.wiktionary.org/wiki/saya Wiktionary saya}
 */

import type { PostalDesignatorTable } from "#postal-designator"

const UPU_MALAYSIA = "https://www.upu.int/UPU/media/upu/PostalEntitiesFiles/addressingUnit/mysEn.pdf"
const WIKTIONARY = "https://en.wiktionary.org/wiki/"

/**
 * Malaysia's designator rows, each carrying the published list it was checked against.
 */
export const MY_POSTAL_DESIGNATORS: PostalDesignatorTable = {
	country: "MY",
	rows: [
		{
			spelling: "Peti Surat",
			abbreviations: [],
			script: "Latn",
			position: "prefix",
			concept: "post_office_box",
			language: "ms",
			source: UPU_MALAYSIA,
		},
		{
			spelling: "Beg Berkunci",
			abbreviations: [],
			script: "Latn",
			position: "prefix",
			concept: "private_bag",
			language: "ms",
			source: UPU_MALAYSIA,
		},
		{
			spelling: "Menara",
			abbreviations: [],
			script: "Latn",
			position: "prefix",
			concept: "tower",
			language: "ms",
			source: `${WIKTIONARY}menara`,
		},
		{
			spelling: "Tingkat",
			abbreviations: [],
			script: "Latn",
			position: "prefix",
			concept: "floor",
			language: "ms",
			source: `${WIKTIONARY}tingkat`,
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
