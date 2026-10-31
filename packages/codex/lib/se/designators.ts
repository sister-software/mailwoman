/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Swedish postal designators: the delivery service, sub-premise, floor and relation words an address or a
 *   query uses.
 *
 * @see {@link https://www.upu.int/UPU/media/upu/PostalEntitiesFiles/addressingUnit/sweEn.pdf UPU Sweden addressing sheet (PostNord)}
 * @see {@link https://en.wiktionary.org/wiki/lägenhet Wiktionary: lägenhet}
 * @see {@link https://en.wiktionary.org/wiki/våning Wiktionary: våning}
 * @see {@link https://en.wiktionary.org/wiki/bredvid Wiktionary: bredvid}
 * @see {@link https://en.wiktionary.org/wiki/nära Wiktionary: nära}
 * @see {@link https://en.wiktionary.org/wiki/near Wiktionary: near (translations)}
 * @see {@link https://en.wiktionary.org/wiki/poste_restante Wiktionary: poste restante}
 */

import { SV_LEVEL_DESIGNATORS } from "#level-semantics"
import { designatorRowsFromLevels, type PostalDesignatorTable } from "#postal/designator"

const UPU_SOURCE = "https://www.upu.int/UPU/media/upu/PostalEntitiesFiles/addressingUnit/sweEn.pdf"

/**
 * The designator rows for Sweden, each carrying the published list it was read from.
 */
export const SE_POSTAL_DESIGNATORS: PostalDesignatorTable = {
	country: "SE",
	rows: [
		{
			spelling: "Poste restante",
			abbreviations: ["PR"],
			script: "Latn",
			position: "standalone",
			concept: "poste_restante",
			language: "sv",
			source: "https://en.wiktionary.org/wiki/poste_restante",
		},
		{
			spelling: "i närheten av",
			abbreviations: [],
			script: "Latn",
			position: "prefix",
			concept: "near",
			language: "sv",
			source: "https://en.wiktionary.org/wiki/near",
		},
		{
			spelling: "Box",
			abbreviations: [],
			script: "Latn",
			position: "prefix",
			concept: "post_office_box",
			language: "sv",
			source: UPU_SOURCE,
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
			spelling: "nära",
			abbreviations: [],
			script: "Latn",
			position: "prefix",
			concept: "near",
			language: "sv",
			source: "https://en.wiktionary.org/wiki/nära",
		},
		{
			spelling: "bredvid",
			abbreviations: [],
			script: "Latn",
			position: "prefix",
			concept: "beside",
			language: "sv",
			source: "https://en.wiktionary.org/wiki/bredvid",
		},
	],
}
