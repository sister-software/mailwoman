/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Saudi postal designators: the delivery service and office in English and the premise, sub-premise, floor
 *   and relation words in Arabic.
 *
 * @see {@link https://www.upu.int/UPU/media/upu/PostalEntitiesFiles/addressingUnit/sauEn.pdf UPU Saudi Arabia addressing sheet (Saudi Post)}
 * @see {@link https://splonline.com.sa/ar/po-box/ Saudi Post: صناديق البريد العادية}
 * @see {@link https://en.wiktionary.org/wiki/near Wiktionary: near (translations)}
 * @see {@link https://en.wiktionary.org/wiki/مبنى Wiktionary: مبنى}
 * @see {@link https://en.wiktionary.org/wiki/شقة Wiktionary: شقة}
 * @see {@link https://en.wiktionary.org/wiki/طابق Wiktionary: طابق}
 * @see {@link https://en.wiktionary.org/wiki/قرب Wiktionary: قرب}
 * @see {@link https://en.wiktionary.org/wiki/بجانب Wiktionary: بجانب}
 */

import type { PostalDesignatorRow, PostalDesignatorTable } from "#postal/designator"

const UPU_SOURCE = "https://www.upu.int/UPU/media/upu/PostalEntitiesFiles/addressingUnit/sauEn.pdf"
const WIKTIONARY = "https://en.wiktionary.org/wiki/"

const arabic = { script: "Arab", language: "ar" } as const satisfies Pick<PostalDesignatorRow, "script" | "language">

/**
 * The designator rows for Saudi Arabia, each carrying the published list it was read from.
 */
export const SA_POSTAL_DESIGNATORS: PostalDesignatorTable = {
	country: "SA",
	rows: [
		{
			...arabic,
			spelling: "صندوق البريد",
			abbreviations: ["ص.ب"],
			position: "prefix",
			concept: "post_office_box",
			source: "https://splonline.com.sa/ar/po-box/",
		},
		{
			...arabic,
			spelling: "بالقرب من",
			abbreviations: [],
			position: "prefix",
			concept: "near",
			source: `${WIKTIONARY}near`,
		},
		{
			spelling: "P.O. Box",
			abbreviations: [],
			script: "Latn",
			position: "prefix",
			concept: "post_office_box",
			language: "en",
			source: UPU_SOURCE,
		},
		{
			spelling: "Office",
			abbreviations: [],
			script: "Latn",
			position: "prefix",
			concept: "office",
			language: "en",
			source: UPU_SOURCE,
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
