/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Danish postal designators: the delivery service, sub-premise, floor and relation words an address or a
 *   query uses.
 *
 * @see {@link https://www.upu.int/UPU/media/upu/PostalEntitiesFiles/addressingUnit/dnkEn.pdf UPU Denmark addressing sheet (Post Danmark)}
 * @see {@link https://en.wiktionary.org/wiki/lejlighed Wiktionary: lejlighed}
 * @see {@link https://en.wiktionary.org/wiki/etage Wiktionary: etage}
 * @see {@link https://en.wiktionary.org/wiki/nær Wiktionary: nær}
 */

import { DA_LEVEL_DESIGNATORS } from "#level-semantics"
import { designatorRowsFromLevels, type PostalDesignatorTable } from "#postal/designator"

/**
 * The designator rows for Denmark, each carrying the published list it was read from.
 */
export const DK_POSTAL_DESIGNATORS: PostalDesignatorTable = {
	country: "DK",
	rows: [
		{
			spelling: "Postboks",
			abbreviations: [],
			script: "Latn",
			position: "prefix",
			concept: "post_office_box",
			language: "da",
			source: "https://www.upu.int/UPU/media/upu/PostalEntitiesFiles/addressingUnit/dnkEn.pdf",
		},
		{
			spelling: "Lejlighed",
			abbreviations: [],
			script: "Latn",
			position: "prefix",
			concept: "apartment",
			language: "da",
			source: "https://en.wiktionary.org/wiki/lejlighed",
		},
		...designatorRowsFromLevels(DA_LEVEL_DESIGNATORS, {
			script: "Latn",
			language: "da",
			source: "https://en.wiktionary.org/wiki/etage",
		}),
		{
			spelling: "nær",
			abbreviations: [],
			script: "Latn",
			position: "prefix",
			concept: "near",
			language: "da",
			source: "https://en.wiktionary.org/wiki/nær",
		},
	],
}
