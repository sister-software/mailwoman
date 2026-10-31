/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Turkish postal designators: the delivery service, premise, sub-premise, floor, number mark and relation
 *   words an address or a query uses.
 *
 * @see {@link https://www.upu.int/UPU/media/upu/PostalEntitiesFiles/addressingUnit/turEn.pdf UPU Türkiye addressing sheet (PTT)}
 * @see {@link https://en.wiktionary.org/wiki/daire Wiktionary: daire}
 * @see {@link https://en.wiktionary.org/wiki/kat Wiktionary: kat}
 * @see {@link https://en.wiktionary.org/wiki/bodrum Wiktionary: bodrum}
 * @see {@link https://en.wiktionary.org/wiki/yanında Wiktionary: yanında}
 * @see {@link https://en.wiktionary.org/wiki/near Wiktionary: near (translations)}
 * @see {@link https://en.wiktionary.org/wiki/yakın Wiktionary: yakın}
 */

import type { PostalDesignatorRow, PostalDesignatorTable } from "#postal/designator"

const UPU_SOURCE = "https://www.upu.int/UPU/media/upu/PostalEntitiesFiles/addressingUnit/turEn.pdf"
const WIKTIONARY = "https://en.wiktionary.org/wiki/"

const turkish = { script: "Latn", language: "tr" } as const satisfies Pick<PostalDesignatorRow, "script" | "language">

/**
 * The designator rows for Türkiye, each carrying the published list it was read from.
 */
export const TR_POSTAL_DESIGNATORS: PostalDesignatorTable = {
	country: "TR",
	rows: [
		{
			...turkish,
			spelling: "yakınında",
			abbreviations: [],
			position: "suffix",
			concept: "near",
			source: "https://en.wiktionary.org/wiki/near",
		},
		{
			...turkish,
			spelling: "yakınımda",
			abbreviations: [],
			position: "standalone",
			concept: "near_asker",
			source: "https://en.wiktionary.org/wiki/yakın",
		},
		{
			...turkish,
			spelling: "Posta kutusu",
			abbreviations: ["PK"],
			position: "prefix",
			concept: "post_office_box",
			source: UPU_SOURCE,
		},
		{
			...turkish,
			spelling: "Postrestant",
			abbreviations: [],
			position: "standalone",
			concept: "poste_restante",
			source: UPU_SOURCE,
		},
		{ ...turkish, spelling: "Blok", abbreviations: [], position: "suffix", concept: "block", source: UPU_SOURCE },
		{
			...turkish,
			spelling: "Daire",
			abbreviations: [],
			position: "prefix",
			concept: "apartment",
			source: `${WIKTIONARY}daire`,
		},
		{
			...turkish,
			spelling: "Kat",
			abbreviations: [],
			position: "prefix",
			concept: "floor",
			source: `${WIKTIONARY}kat`,
		},
		{
			...turkish,
			spelling: "Bodrum",
			abbreviations: [],
			position: "prefix",
			concept: "basement",
			source: `${WIKTIONARY}bodrum`,
		},
		{
			...turkish,
			spelling: "No",
			abbreviations: ["No:"],
			position: "prefix",
			concept: "number_sign",
			source: UPU_SOURCE,
		},
		{
			...turkish,
			spelling: "yanında",
			abbreviations: [],
			position: "suffix",
			concept: "beside",
			source: `${WIKTIONARY}yanında`,
		},
	],
}
