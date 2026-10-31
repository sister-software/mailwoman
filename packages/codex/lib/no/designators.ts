/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Norwegian postal designators: the delivery service, sub-premise, floor and relation words an address or a
 *   query uses.
 *
 * @see {@link https://www.upu.int/UPU/media/upu/PostalEntitiesFiles/addressingUnit/norEn.pdf UPU Norway addressing sheet (Posten Norge)}
 * @see {@link https://en.wiktionary.org/wiki/leilighet Wiktionary: leilighet}
 * @see {@link https://en.wiktionary.org/wiki/etasje Wiktionary: etasje}
 * @see {@link https://en.wiktionary.org/wiki/nær Wiktionary: nær}
 */

import { NO_LEVEL_DESIGNATORS } from "#level-semantics"
import { designatorRowsFromLevels, type PostalDesignatorTable } from "#postal/designator"

const UPU_SOURCE = "https://www.upu.int/UPU/media/upu/PostalEntitiesFiles/addressingUnit/norEn.pdf"

/**
 * The designator rows for Norway, each carrying the published list it was read from.
 */
export const NO_POSTAL_DESIGNATORS: PostalDesignatorTable = {
	country: "NO",
	rows: [
		{
			spelling: "Postboks",
			abbreviations: ["PO Box"],
			script: "Latn",
			position: "prefix",
			concept: "post_office_box",
			language: "no",
			source: UPU_SOURCE,
		},
		{
			spelling: "Bolignummer",
			abbreviations: [],
			script: "Latn",
			position: "prefix",
			concept: "unit",
			language: "no",
			source: UPU_SOURCE,
		},
		{
			spelling: "Leilighet",
			abbreviations: [],
			script: "Latn",
			position: "prefix",
			concept: "apartment",
			language: "no",
			source: "https://en.wiktionary.org/wiki/leilighet",
		},
		...designatorRowsFromLevels(NO_LEVEL_DESIGNATORS, {
			script: "Latn",
			language: "no",
			source: "https://en.wiktionary.org/wiki/etasje",
		}),
		{
			spelling: "nær",
			abbreviations: [],
			script: "Latn",
			position: "prefix",
			concept: "near",
			language: "no",
			source: "https://en.wiktionary.org/wiki/nær",
		},
	],
}
