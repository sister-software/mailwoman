/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Russian postal designators: the delivery service, premise, sub-premise, floor, number mark and relation
 *   words an address or a query uses. The UPU sheet lists the postal abbreviations in Latin transliteration, and
 *   the rows give them in Cyrillic.
 *
 * @see {@link https://www.upu.int/UPU/media/upu/PostalEntitiesFiles/addressingUnit/rusEn.pdf UPU Russian Federation addressing sheet (Russian Post)}
 * @see {@link https://en.wiktionary.org/wiki/строение Wiktionary: строение}
 * @see {@link https://ru.wiktionary.org/wiki/стр. Russian Wiktionary: стр.}
 * @see {@link https://ru.wiktionary.org/wiki/корп. Russian Wiktionary: корп.}
 * @see {@link https://en.wikipedia.org/wiki/Numero_sign Wikipedia: Numero sign}
 * @see {@link https://en.wiktionary.org/wiki/подъезд Wiktionary: подъезд}
 * @see {@link https://en.wiktionary.org/wiki/этаж Wiktionary: этаж}
 * @see {@link https://en.wiktionary.org/wiki/возле Wiktionary: возле}
 * @see {@link https://en.wiktionary.org/wiki/рядом Wiktionary: рядом}
 * @see {@link https://en.wiktionary.org/wiki/около Wiktionary: около}
 * @see {@link https://en.wiktionary.org/wiki/поблизости Wiktionary: поблизости}
 * @see {@link https://en.wiktionary.org/wiki/напротив Wiktionary: напротив}
 */

import type { PostalDesignatorRow, PostalDesignatorTable } from "#postal-designator"

const UPU_SOURCE = "https://www.upu.int/UPU/media/upu/PostalEntitiesFiles/addressingUnit/rusEn.pdf"
const WIKTIONARY = "https://en.wiktionary.org/wiki/"

const russian = { script: "Cyrl", language: "ru" } as const satisfies Pick<PostalDesignatorRow, "script" | "language">

/**
 * The designator rows for Russia, each carrying the published list it was read from.
 */
export const RU_POSTAL_DESIGNATORS: PostalDesignatorTable = {
	country: "RU",
	rows: [
		{
			...russian,
			spelling: "стр.",
			abbreviations: [],
			position: "prefix",
			concept: "building",
			source: "https://ru.wiktionary.org/wiki/стр.",
		},
		{
			...russian,
			spelling: "корп.",
			abbreviations: [],
			position: "prefix",
			concept: "building",
			source: "https://ru.wiktionary.org/wiki/корп.",
		},
		{
			...russian,
			spelling: "№",
			abbreviations: [],
			position: "prefix",
			concept: "number_sign",
			source: "https://en.wikipedia.org/wiki/Numero_sign",
		},
		{
			...russian,
			spelling: "абонентский ящик",
			abbreviations: ["а/я"],
			position: "prefix",
			concept: "post_office_box",
			source: UPU_SOURCE,
		},
		{
			...russian,
			spelling: "до востребования",
			abbreviations: [],
			position: "standalone",
			concept: "poste_restante",
			source: UPU_SOURCE,
		},
		{
			...russian,
			spelling: "корпус",
			abbreviations: ["к."],
			position: "prefix",
			concept: "building",
			source: UPU_SOURCE,
		},
		{
			...russian,
			spelling: "строение",
			abbreviations: [],
			position: "prefix",
			concept: "building",
			source: `${WIKTIONARY}строение`,
		},
		{
			...russian,
			spelling: "подъезд",
			abbreviations: [],
			position: "prefix",
			concept: "entrance",
			source: `${WIKTIONARY}подъезд`,
		},
		{
			...russian,
			spelling: "квартира",
			abbreviations: ["кв."],
			position: "prefix",
			concept: "apartment",
			source: UPU_SOURCE,
		},
		{
			...russian,
			spelling: "этаж",
			abbreviations: [],
			position: "suffix",
			concept: "floor",
			source: `${WIKTIONARY}этаж`,
		},
		{
			...russian,
			spelling: "дом",
			abbreviations: ["д."],
			position: "prefix",
			concept: "number_sign",
			source: UPU_SOURCE,
		},
		{
			...russian,
			spelling: "возле",
			abbreviations: [],
			position: "prefix",
			concept: "near",
			source: `${WIKTIONARY}возле`,
		},
		{
			...russian,
			spelling: "около",
			abbreviations: [],
			position: "prefix",
			concept: "near",
			source: `${WIKTIONARY}около`,
		},
		{
			...russian,
			spelling: "поблизости",
			abbreviations: [],
			position: "standalone",
			concept: "near",
			source: `${WIKTIONARY}поблизости`,
		},
		{
			...russian,
			spelling: "рядом с",
			abbreviations: [],
			position: "prefix",
			concept: "beside",
			source: `${WIKTIONARY}рядом`,
		},
		{
			...russian,
			spelling: "напротив",
			abbreviations: [],
			position: "prefix",
			concept: "opposite",
			source: `${WIKTIONARY}напротив`,
		},
	],
}
