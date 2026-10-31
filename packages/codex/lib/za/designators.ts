/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   South African postal designators in English: the postal delivery services SAPO's addressing sheet lists.
 *
 * @see {@link https://www.upu.int/UPU/media/upu/PostalEntitiesFiles/addressingUnit/zafEn.pdf UPU South Africa addressing sheet (SAPO)}
 * @see {@link https://www.upu.int/UPU/media/upu/PostalEntitiesFiles/s42/zafFr.pdf UPU S42 South Africa standardized address format description (POSBUS and PRIVAATSAK examples)}
 */

import type { PostalDesignatorRow, PostalDesignatorTable } from "#postal/designator"

const SOURCE = "https://www.upu.int/UPU/media/upu/PostalEntitiesFiles/addressingUnit/zafEn.pdf"

const english = { script: "Latn", language: "en", source: SOURCE } as const satisfies Pick<
	PostalDesignatorRow,
	"script" | "language" | "source"
>

/**
 * The designator rows for South Africa, each carrying the published list it was read from.
 */
export const ZA_POSTAL_DESIGNATORS: PostalDesignatorTable = {
	country: "ZA",
	rows: [
		{
			spelling: "Posbus",
			abbreviations: [],
			script: "Latn",
			position: "prefix",
			concept: "post_office_box",
			language: "af",
			source: "https://www.upu.int/UPU/media/upu/PostalEntitiesFiles/s42/zafFr.pdf",
		},
		{
			spelling: "Privaatsak",
			abbreviations: [],
			script: "Latn",
			position: "prefix",
			concept: "private_bag",
			language: "af",
			source: "https://www.upu.int/UPU/media/upu/PostalEntitiesFiles/s42/zafFr.pdf",
		},
		{ ...english, spelling: "PO Box", abbreviations: [], position: "prefix", concept: "post_office_box" },
		{ ...english, spelling: "Private Bag", abbreviations: [], position: "prefix", concept: "private_bag" },
	],
}
