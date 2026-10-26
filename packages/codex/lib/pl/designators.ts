/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Polish postal designators: the delivery service, premise, sub-premise, floor and relation words an address
 *   or a query uses.
 *
 * @see {@link https://www.upu.int/UPU/media/upu/PostalEntitiesFiles/addressingUnit/polEn.pdf UPU Poland addressing sheet (Poczta Polska)}
 * @see {@link https://www.poczta-polska.pl/wp-content/uploads/2025/09/Zasady-poprawnego-adresowania-przesylek.pdf Poczta Polska: Zasady poprawnego adresowania i oznakowania przesyłek listowych}
 * @see {@link https://pl.wiktionary.org/wiki/lok. Polish Wiktionary: lok.}
 * @see {@link https://pl.wiktionary.org/wiki/m. Polish Wiktionary: m.}
 * @see {@link https://en.wiktionary.org/wiki/budynek Wiktionary: budynek}
 * @see {@link https://en.wiktionary.org/wiki/blok Wiktionary: blok}
 * @see {@link https://en.wiktionary.org/wiki/klatka_schodowa Wiktionary: klatka schodowa}
 * @see {@link https://en.wiktionary.org/wiki/lokal Wiktionary: lokal}
 * @see {@link https://en.wiktionary.org/wiki/mieszkanie Wiktionary: mieszkanie}
 * @see {@link https://en.wiktionary.org/wiki/piętro Wiktionary: piętro}
 * @see {@link https://en.wiktionary.org/wiki/blisko Wiktionary: blisko}
 * @see {@link https://en.wiktionary.org/wiki/pobliże Wiktionary: pobliże}
 * @see {@link https://en.wiktionary.org/wiki/obok Wiktionary: obok}
 */

import type { PostalDesignatorRow, PostalDesignatorTable } from "#postal-designator"

const UPU_SOURCE = "https://www.upu.int/UPU/media/upu/PostalEntitiesFiles/addressingUnit/polEn.pdf"
const WIKTIONARY = "https://en.wiktionary.org/wiki/"

const polish = { script: "Latn", language: "pl" } as const satisfies Pick<PostalDesignatorRow, "script" | "language">

/**
 * The designator rows for Poland, each carrying the published list it was read from.
 */
export const PL_POSTAL_DESIGNATORS: PostalDesignatorTable = {
	country: "PL",
	rows: [
		{
			...polish,
			spelling: "skr. poczt.",
			abbreviations: [],
			position: "prefix",
			concept: "post_office_box",
			source: "https://www.poczta-polska.pl/wp-content/uploads/2025/09/Zasady-poprawnego-adresowania-przesylek.pdf",
		},
		{
			...polish,
			spelling: "lok.",
			abbreviations: [],
			position: "prefix",
			concept: "unit",
			source: "https://pl.wiktionary.org/wiki/lok.",
		},
		{
			...polish,
			spelling: "m.",
			abbreviations: [],
			position: "prefix",
			concept: "apartment",
			source: "https://pl.wiktionary.org/wiki/m.",
		},
		{
			...polish,
			spelling: "Skrytka pocztowa",
			abbreviations: [],
			position: "prefix",
			concept: "post_office_box",
			source: UPU_SOURCE,
		},
		{
			...polish,
			spelling: "Poste restante",
			abbreviations: [],
			position: "standalone",
			concept: "poste_restante",
			source: UPU_SOURCE,
		},
		{
			...polish,
			spelling: "Budynek",
			abbreviations: [],
			position: "prefix",
			concept: "building",
			source: `${WIKTIONARY}budynek`,
		},
		{
			...polish,
			spelling: "Blok",
			abbreviations: [],
			position: "prefix",
			concept: "block",
			source: `${WIKTIONARY}blok`,
		},
		{
			...polish,
			spelling: "Klatka schodowa",
			abbreviations: [],
			position: "prefix",
			concept: "staircase",
			source: `${WIKTIONARY}klatka_schodowa`,
		},
		{
			...polish,
			spelling: "Lokal",
			abbreviations: [],
			position: "prefix",
			concept: "unit",
			source: `${WIKTIONARY}lokal`,
		},
		{
			...polish,
			spelling: "Mieszkanie",
			abbreviations: [],
			position: "prefix",
			concept: "apartment",
			source: `${WIKTIONARY}mieszkanie`,
		},
		{
			...polish,
			spelling: "piętro",
			abbreviations: ["p."],
			position: "suffix",
			concept: "floor",
			source: `${WIKTIONARY}piętro`,
		},
		{
			...polish,
			spelling: "blisko",
			abbreviations: [],
			position: "prefix",
			concept: "near",
			source: `${WIKTIONARY}blisko`,
		},
		{
			...polish,
			spelling: "w pobliżu",
			abbreviations: [],
			position: "prefix",
			concept: "near",
			source: `${WIKTIONARY}pobliże`,
		},
		{
			...polish,
			spelling: "obok",
			abbreviations: [],
			position: "prefix",
			concept: "beside",
			source: `${WIKTIONARY}obok`,
		},
	],
}
