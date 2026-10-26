/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Finnish postal designators in Finnish and Swedish: the delivery service, sub-premise, floor and relation
 *   words an address or a query uses.
 *
 * @see {@link https://www.upu.int/UPU/media/upu/PostalEntitiesFiles/addressingUnit/finEn.pdf UPU Finland addressing sheet (Posti)}
 * @see {@link https://en.wiktionary.org/wiki/huoneisto Wiktionary: huoneisto}
 * @see {@link https://en.wiktionary.org/wiki/kerros Wiktionary: kerros}
 * @see {@link https://en.wiktionary.org/wiki/lähellä Wiktionary: lähellä}
 * @see {@link https://en.wiktionary.org/wiki/vieressä Wiktionary: vieressä}
 * @see {@link https://en.wiktionary.org/wiki/lägenhet Wiktionary: lägenhet}
 * @see {@link https://en.wiktionary.org/wiki/våning Wiktionary: våning}
 */

import { SV_LEVEL_DESIGNATORS } from "#level-semantics"
import { designatorRowsFromLevels, type PostalDesignatorTable } from "#postal-designator"

const UPU_SOURCE = "https://www.upu.int/UPU/media/upu/PostalEntitiesFiles/addressingUnit/finEn.pdf"

/**
 * The designator rows for Finland, each carrying the published list it was read from.
 */
export const FI_POSTAL_DESIGNATORS: PostalDesignatorTable = {
	country: "FI",
	rows: [
		{
			spelling: "PL",
			abbreviations: [],
			script: "Latn",
			position: "prefix",
			concept: "post_office_box",
			language: "fi",
			source: UPU_SOURCE,
		},
		{
			spelling: "Poste restante",
			abbreviations: [],
			script: "Latn",
			position: "standalone",
			concept: "poste_restante",
			language: "fi",
			source: UPU_SOURCE,
		},
		{
			spelling: "huoneisto",
			abbreviations: [],
			script: "Latn",
			position: "prefix",
			concept: "apartment",
			language: "fi",
			source: "https://en.wiktionary.org/wiki/huoneisto",
		},
		{
			spelling: "kerros",
			abbreviations: [],
			script: "Latn",
			position: "suffix",
			concept: "floor",
			language: "fi",
			source: "https://en.wiktionary.org/wiki/kerros",
		},
		{
			spelling: "Lägenhet",
			abbreviations: ["Lgh"],
			script: "Latn",
			position: "prefix",
			concept: "apartment",
			language: "sv",
			source: "https://en.wiktionary.org/wiki/lägenhet",
		},
		...designatorRowsFromLevels(SV_LEVEL_DESIGNATORS, {
			script: "Latn",
			language: "sv",
			source: "https://en.wiktionary.org/wiki/våning",
		}),
		{
			spelling: "lähellä",
			abbreviations: [],
			script: "Latn",
			position: "suffix",
			concept: "near",
			language: "fi",
			source: "https://en.wiktionary.org/wiki/lähellä",
		},
		{
			spelling: "vieressä",
			abbreviations: [],
			script: "Latn",
			position: "suffix",
			concept: "beside",
			language: "fi",
			source: "https://en.wiktionary.org/wiki/vieressä",
		},
	],
}
