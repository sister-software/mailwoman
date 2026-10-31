/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The designators a Dutch address uses: the Postbus, building and room words, floors, and the relation
 *   words of a query.
 *
 * @see {@link https://www.upu.int/UPU/media/upu/PostalEntitiesFiles/addressingUnit/nldEn.pdf UPU, Netherlands addressing sheet}
 * @see {@link https://en.wiktionary.org/wiki/nabij Wiktionary, nabij}
 * @see {@link https://en.wiktionary.org/wiki/naast Wiktionary, naast}
 * @see {@link https://en.wiktionary.org/wiki/tegenover Wiktionary, tegenover}
 * @see {@link https://en.wiktionary.org/wiki/bij Wiktionary, bij}
 * @see {@link https://en.wiktionary.org/wiki/buurt Wiktionary, buurt}
 */

import { NL_LEVEL_DESIGNATORS } from "#level-semantics"
import { designatorRowsFromLevels, type PostalDesignatorTable } from "#postal/designator"

const UPU_NETHERLANDS = "https://www.upu.int/UPU/media/upu/PostalEntitiesFiles/addressingUnit/nldEn.pdf"
const WIKTIONARY = "https://en.wiktionary.org/wiki/"
const LEVEL_LEXICON = "packages/codex/lib/level-semantics.ts, common building usage with no published authority"

const NL = { script: "Latn", language: "nl" } as const

/**
 * Dutch postal designators.
 */
export const NL_POSTAL_DESIGNATORS: PostalDesignatorTable = {
	country: "NL",
	rows: [
		// Delivery services.
		{
			...NL,
			spelling: "Postbus",
			abbreviations: [],
			position: "prefix",
			concept: "post_office_box",
			source: UPU_NETHERLANDS,
		},
		// Premise and sub-premise, as the UPU sheet writes `Gebouw Westpoint Kamer 8 II`.
		{
			...NL,
			spelling: "Gebouw",
			abbreviations: [],
			position: "prefix",
			concept: "building",
			source: UPU_NETHERLANDS,
		},
		{
			...NL,
			spelling: "Kamer",
			abbreviations: [],
			position: "prefix",
			concept: "room",
			source: UPU_NETHERLANDS,
		},
		// Floors.
		...designatorRowsFromLevels(NL_LEVEL_DESIGNATORS, { ...NL, source: LEVEL_LEXICON }),
		// Relation words in a query.
		{
			...NL,
			spelling: "nabij",
			abbreviations: [],
			position: "prefix",
			concept: "near",
			source: `${WIKTIONARY}nabij`,
		},
		{
			...NL,
			spelling: "bij",
			abbreviations: [],
			position: "prefix",
			concept: "near",
			source: `${WIKTIONARY}bij`,
		},
		{
			...NL,
			spelling: "naast",
			abbreviations: [],
			position: "prefix",
			concept: "beside",
			source: `${WIKTIONARY}naast`,
		},
		{
			...NL,
			spelling: "tegenover",
			abbreviations: [],
			position: "prefix",
			concept: "opposite",
			source: `${WIKTIONARY}tegenover`,
		},
		{
			...NL,
			spelling: "in de buurt van",
			abbreviations: ["in de buurt"],
			position: "prefix",
			concept: "near",
			source: `${WIKTIONARY}buurt`,
		},
	],
}
