/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The designators an Austrian address uses: the Postfach, floors, and the relation words of a query. The
 *   floor and relation words are the German ones.
 *
 * @see {@link https://www.upu.int/UPU/media/upu/PostalEntitiesFiles/addressingUnit/autEn.pdf UPU, Austria addressing sheet}
 * @see {@link https://en.wiktionary.org/wiki/in_der_Nähe Wiktionary, in der Nähe}
 * @see {@link https://en.wiktionary.org/wiki/bei Wiktionary, bei}
 * @see {@link https://en.wiktionary.org/wiki/neben Wiktionary, neben}
 * @see {@link https://en.wiktionary.org/wiki/gegenüber Wiktionary, gegenüber}
 * @see {@link https://en.wiktionary.org/wiki/apartment#Translations Wiktionary, apartment, translations}
 * @see {@link https://en.wiktionary.org/wiki/Whg. Wiktionary, Whg.}
 * @see {@link https://en.wiktionary.org/wiki/building#Translations Wiktionary, building, translations}
 * @see {@link https://en.wiktionary.org/wiki/entrance#Translations Wiktionary, entrance, translations}
 * @see {@link https://en.wiktionary.org/wiki/Aufgang Wiktionary, Aufgang}
 * @see {@link https://en.wiktionary.org/wiki/Stiege Wiktionary, Stiege}
 * @see {@link https://en.wiktionary.org/wiki/meiner Wiktionary, meiner}
 */

import { DE_LEVEL_DESIGNATORS } from "#level-semantics"
import { designatorRowsFromLevels, type PostalDesignatorTable } from "#postal-designator"

const UPU_AUSTRIA = "https://www.upu.int/UPU/media/upu/PostalEntitiesFiles/addressingUnit/autEn.pdf"
const WIKTIONARY = "https://en.wiktionary.org/wiki/"

const composedFrom = (near: string, pronoun: string) =>
	`composed from the ${near} row and the first-person pronoun (Wiktionary ${WIKTIONARY}${pronoun})`

const LEVEL_LEXICON = "packages/codex/lib/level-semantics.ts, common building usage with no published authority"

const DE = { script: "Latn", language: "de" } as const

/**
 * Austrian postal designators.
 */
export const AT_POSTAL_DESIGNATORS: PostalDesignatorTable = {
	country: "AT",
	rows: [
		// Delivery services.
		{
			...DE,
			spelling: "Postfach",
			abbreviations: [],
			position: "prefix",
			concept: "post_office_box",
			source: UPU_AUSTRIA,
		},
		// Floors.
		...designatorRowsFromLevels(DE_LEVEL_DESIGNATORS, { ...DE, source: LEVEL_LEXICON }),
		// Relation words in a query.
		{
			...DE,
			spelling: "in der Nähe von",
			abbreviations: ["in der Nähe"],
			position: "prefix",
			concept: "near",
			source: `${WIKTIONARY}in_der_Nähe`,
		},
		{
			...DE,
			spelling: "bei",
			abbreviations: [],
			position: "prefix",
			concept: "near",
			source: `${WIKTIONARY}bei`,
		},
		{
			...DE,
			spelling: "neben",
			abbreviations: [],
			position: "prefix",
			concept: "beside",
			source: `${WIKTIONARY}neben`,
		},
		{
			...DE,
			spelling: "gegenüber",
			abbreviations: [],
			position: "prefix",
			concept: "opposite",
			source: `${WIKTIONARY}gegenüber`,
		},
		// Premise and sub-premise.
		{
			...DE,
			spelling: "Wohnung",
			abbreviations: ["Whg."],
			position: "prefix",
			concept: "apartment",
			source: `${WIKTIONARY}apartment#Translations and ${WIKTIONARY}Whg.`,
		},
		{
			...DE,
			spelling: "Gebäude",
			abbreviations: [],
			position: "prefix",
			concept: "building",
			source: `${WIKTIONARY}building#Translations`,
		},
		{
			...DE,
			spelling: "Eingang",
			abbreviations: [],
			position: "prefix",
			concept: "entrance",
			source: `${WIKTIONARY}entrance#Translations`,
		},
		{
			...DE,
			spelling: "Aufgang",
			abbreviations: [],
			position: "prefix",
			concept: "staircase",
			source: `${WIKTIONARY}Aufgang`,
		},
		{
			...DE,
			spelling: "Stiege",
			abbreviations: [],
			position: "prefix",
			concept: "staircase",
			source: `${WIKTIONARY}Stiege`,
		},
		// Near the asker.
		{
			...DE,
			spelling: "in meiner Nähe",
			abbreviations: [],
			position: "standalone",
			concept: "near_asker",
			source: composedFrom("in der Nähe", "meiner"),
		},
	],
}
