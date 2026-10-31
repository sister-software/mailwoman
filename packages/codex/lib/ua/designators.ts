/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Ukrainian postal designators: the premise, sub-premise, floor and relation words an address or a query
 *   uses. The UPU sheet lists the apartment abbreviation in Latin transliteration, and the row gives it in
 *   Cyrillic.
 *
 * @see {@link https://www.upu.int/UPU/media/upu/PostalEntitiesFiles/addressingUnit/ukrEn.pdf UPU Ukraine addressing sheet (Ukrposhta)}
 * @see {@link https://en.wiktionary.org/wiki/будинок Wiktionary: будинок}
 * @see {@link https://en.wiktionary.org/wiki/корпус Wiktionary: корпус}
 * @see {@link https://en.wiktionary.org/wiki/під'їзд Wiktionary: під'їзд}
 * @see {@link https://en.wiktionary.org/wiki/поверх Wiktionary: поверх}
 * @see {@link https://en.wiktionary.org/wiki/біля Wiktionary: біля}
 * @see {@link https://en.wiktionary.org/wiki/поруч Wiktionary: поруч}
 * @see {@link https://en.wikipedia.org/wiki/Numero_sign Wikipedia: Numero sign}
 */

import type { PostalDesignatorRow, PostalDesignatorTable } from "#postal/designator"

const UPU_SOURCE = "https://www.upu.int/UPU/media/upu/PostalEntitiesFiles/addressingUnit/ukrEn.pdf"
const WIKTIONARY = "https://en.wiktionary.org/wiki/"

const ukrainian = { script: "Cyrl", language: "uk" } as const satisfies Pick<PostalDesignatorRow, "script" | "language">

/**
 * The designator rows for Ukraine, each carrying the published list it was read from.
 */
export const UA_POSTAL_DESIGNATORS: PostalDesignatorTable = {
	country: "UA",
	rows: [
		{
			...ukrainian,
			spelling: "№",
			abbreviations: [],
			position: "prefix",
			concept: "number_sign",
			source: "https://en.wikipedia.org/wiki/Numero_sign",
		},
		{
			...ukrainian,
			spelling: "будинок",
			abbreviations: [],
			position: "prefix",
			concept: "building",
			source: `${WIKTIONARY}будинок`,
		},
		{
			...ukrainian,
			spelling: "корпус",
			abbreviations: [],
			position: "prefix",
			concept: "building",
			source: `${WIKTIONARY}корпус`,
		},
		{
			...ukrainian,
			spelling: "під'їзд",
			abbreviations: [],
			position: "prefix",
			concept: "entrance",
			source: `${WIKTIONARY}під'їзд`,
		},
		{
			...ukrainian,
			spelling: "квартира",
			abbreviations: ["кв."],
			position: "prefix",
			concept: "apartment",
			source: UPU_SOURCE,
		},
		{
			...ukrainian,
			spelling: "поверх",
			abbreviations: [],
			position: "suffix",
			concept: "floor",
			source: `${WIKTIONARY}поверх`,
		},
		{
			...ukrainian,
			spelling: "біля",
			abbreviations: [],
			position: "prefix",
			concept: "near",
			source: `${WIKTIONARY}біля`,
		},
		{
			...ukrainian,
			spelling: "поруч з",
			abbreviations: [],
			position: "prefix",
			concept: "beside",
			source: `${WIKTIONARY}поруч`,
		},
	],
}
