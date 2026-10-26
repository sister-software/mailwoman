/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Egyptian postal designators: the delivery service in English and the premise, sub-premise, floor and
 *   relation words in Arabic.
 *
 * @see {@link https://www.upu.int/UPU/media/upu/PostalEntitiesFiles/addressingUnit/egyEn.pdf UPU Egypt addressing sheet (Egypt Post)}
 * @see {@link https://en.wiktionary.org/wiki/near Wiktionary: near (translations)}
 * @see {@link https://en.wiktionary.org/wiki/مبنى Wiktionary: مبنى}
 * @see {@link https://en.wiktionary.org/wiki/شقة Wiktionary: شقة}
 * @see {@link https://en.wiktionary.org/wiki/طابق Wiktionary: طابق}
 * @see {@link https://en.wiktionary.org/wiki/قرب Wiktionary: قرب}
 * @see {@link https://en.wiktionary.org/wiki/بجانب Wiktionary: بجانب}
 */

import type { PostalDesignatorRow, PostalDesignatorTable } from "#postal-designator"

const WIKTIONARY = "https://en.wiktionary.org/wiki/"

const arabic = { script: "Arab", language: "ar" } as const satisfies Pick<PostalDesignatorRow, "script" | "language">

/**
 * The designator rows for Egypt, each carrying the published list it was read from.
 */
export const EG_POSTAL_DESIGNATORS: PostalDesignatorTable = {
	country: "EG",
	rows: [
		{
			...arabic,
			spelling: "بالقرب من",
			abbreviations: [],
			position: "prefix",
			concept: "near",
			source: `${WIKTIONARY}near`,
		},
		{
			spelling: "P. O. Box",
			abbreviations: [],
			script: "Latn",
			position: "prefix",
			concept: "post_office_box",
			language: "en",
			source: "https://www.upu.int/UPU/media/upu/PostalEntitiesFiles/addressingUnit/egyEn.pdf",
		},
		{
			...arabic,
			spelling: "مبنى",
			abbreviations: [],
			position: "prefix",
			concept: "building",
			source: `${WIKTIONARY}مبنى`,
		},
		{
			...arabic,
			spelling: "شقة",
			abbreviations: [],
			position: "prefix",
			concept: "apartment",
			source: `${WIKTIONARY}شقة`,
		},
		{
			...arabic,
			spelling: "طابق",
			abbreviations: [],
			position: "prefix",
			concept: "floor",
			source: `${WIKTIONARY}طابق`,
		},
		{
			...arabic,
			spelling: "قرب",
			abbreviations: [],
			position: "prefix",
			concept: "near",
			source: `${WIKTIONARY}قرب`,
		},
		{
			...arabic,
			spelling: "بجانب",
			abbreviations: [],
			position: "prefix",
			concept: "beside",
			source: `${WIKTIONARY}بجانب`,
		},
	],
}
