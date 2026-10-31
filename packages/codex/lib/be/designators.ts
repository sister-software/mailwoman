/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The designators a Belgian address uses, in Dutch, French and German: the Postbus and boîte postale, the
 *   box number literals `bus`, `bte` and `box`, the building, floor and room words, and the relation words of a
 *   query.
 *
 *   The bpost sheet lists `n°` and `nr` as marks that must not stand between a street number and its box number.
 *   The rows record them as number marks. The German premise words have no row, because the sheet lists German
 *   thoroughfare types only.
 *
 * @see {@link https://www.upu.int/UPU/media/upu/PostalEntitiesFiles/addressingUnit/belEn.pdf UPU, Belgium addressing sheet}
 * @see {@link https://en.wiktionary.org/wiki/nabij Wiktionary, nabij}
 * @see {@link https://en.wiktionary.org/wiki/naast Wiktionary, naast}
 * @see {@link https://en.wiktionary.org/wiki/tegenover Wiktionary, tegenover}
 * @see {@link https://en.wiktionary.org/wiki/bij Wiktionary, bij}
 * @see {@link https://en.wiktionary.org/wiki/près_de Wiktionary, près de}
 * @see {@link https://en.wiktionary.org/wiki/à_côté_de Wiktionary, à côté de}
 * @see {@link https://en.wiktionary.org/wiki/en_face_de Wiktionary, en face de}
 * @see {@link https://en.wiktionary.org/wiki/dans Wiktionary, dans}
 * @see {@link https://en.wiktionary.org/wiki/in_der_Nähe Wiktionary, in der Nähe}
 * @see {@link https://en.wiktionary.org/wiki/bei Wiktionary, bei}
 * @see {@link https://en.wiktionary.org/wiki/neben Wiktionary, neben}
 * @see {@link https://en.wiktionary.org/wiki/gegenüber Wiktionary, gegenüber}
 * @see {@link https://en.wiktionary.org/wiki/buurt Wiktionary, buurt}
 * @see {@link https://en.wiktionary.org/wiki/moi Wiktionary, moi}
 * @see {@link https://en.wiktionary.org/wiki/meiner Wiktionary, meiner}
 */

import { DE_LEVEL_DESIGNATORS, FR_LEVEL_DESIGNATORS, NL_LEVEL_DESIGNATORS } from "#level-semantics"
import { designatorRowsFromLevels, type PostalDesignatorTable } from "#postal/designator"

const UPU_BELGIUM = "https://www.upu.int/UPU/media/upu/PostalEntitiesFiles/addressingUnit/belEn.pdf"
const WIKTIONARY = "https://en.wiktionary.org/wiki/"

const composedFrom = (near: string, pronoun: string) =>
	`composed from the ${near} row and the first-person pronoun (Wiktionary ${WIKTIONARY}${pronoun})`

const LEVEL_LEXICON = "packages/codex/lib/level-semantics.ts, common building usage with no published authority"

const NL = { script: "Latn", language: "nl" } as const
const FR = { script: "Latn", language: "fr" } as const
const DE = { script: "Latn", language: "de" } as const
const EN = { script: "Latn", language: "en" } as const

/**
 * Belgian postal designators.
 */
export const BE_POSTAL_DESIGNATORS: PostalDesignatorTable = {
	country: "BE",
	rows: [
		// Delivery services.
		{
			...NL,
			spelling: "Postbus",
			abbreviations: [],
			position: "prefix",
			concept: "post_office_box",
			source: UPU_BELGIUM,
		},
		{
			...FR,
			spelling: "Boîte postale",
			abbreviations: [],
			position: "prefix",
			concept: "post_office_box",
			source: UPU_BELGIUM,
		},
		// Premise, as the sheet writes `Gebouw A - Verdiep 3 - Kamer 8`.
		{
			...NL,
			spelling: "Gebouw",
			abbreviations: ["geb."],
			position: "prefix",
			concept: "building",
			source: UPU_BELGIUM,
		},
		// Sub-premise: the box number inside a building, and the room.
		{
			...NL,
			spelling: "bus",
			abbreviations: [],
			position: "prefix",
			concept: "unit",
			source: UPU_BELGIUM,
		},
		{
			...FR,
			spelling: "bte",
			abbreviations: [],
			position: "prefix",
			concept: "unit",
			source: UPU_BELGIUM,
		},
		{
			...EN,
			spelling: "box",
			abbreviations: [],
			position: "prefix",
			concept: "unit",
			source: UPU_BELGIUM,
		},
		{
			...NL,
			spelling: "Kamer",
			abbreviations: [],
			position: "prefix",
			concept: "room",
			source: UPU_BELGIUM,
		},
		// Floors: the shared lexicons, then the word the sheet writes that the Dutch lexicon lacks.
		...designatorRowsFromLevels(NL_LEVEL_DESIGNATORS, { ...NL, source: LEVEL_LEXICON }),
		...designatorRowsFromLevels(FR_LEVEL_DESIGNATORS, { ...FR, source: LEVEL_LEXICON }),
		...designatorRowsFromLevels(DE_LEVEL_DESIGNATORS, { ...DE, source: LEVEL_LEXICON }),
		{
			...NL,
			spelling: "Verdiep",
			abbreviations: [],
			position: "prefix",
			concept: "floor",
			source: UPU_BELGIUM,
		},
		// Number marks.
		{
			...FR,
			spelling: "n°",
			abbreviations: [],
			position: "prefix",
			concept: "number_sign",
			source: UPU_BELGIUM,
		},
		{
			...NL,
			spelling: "nr",
			abbreviations: [],
			position: "prefix",
			concept: "number_sign",
			source: UPU_BELGIUM,
		},
		// Relation words in a query, Dutch.
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
		// Relation words in a query, French.
		{
			...FR,
			spelling: "près de",
			abbreviations: [],
			position: "prefix",
			concept: "near",
			source: `${WIKTIONARY}près_de`,
		},
		{
			...FR,
			spelling: "à côté de",
			abbreviations: [],
			position: "prefix",
			concept: "beside",
			source: `${WIKTIONARY}à_côté_de`,
		},
		{
			...FR,
			spelling: "en face de",
			abbreviations: [],
			position: "prefix",
			concept: "opposite",
			source: `${WIKTIONARY}en_face_de`,
		},
		{
			...FR,
			spelling: "dans",
			abbreviations: [],
			position: "prefix",
			concept: "in",
			source: `${WIKTIONARY}dans`,
		},
		// Relation words in a query, German.
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
		{
			...NL,
			spelling: "in de buurt van",
			abbreviations: ["in de buurt"],
			position: "prefix",
			concept: "near",
			source: `${WIKTIONARY}buurt`,
		},
		// Near the asker.
		{
			...FR,
			spelling: "près de moi",
			abbreviations: [],
			position: "standalone",
			concept: "near_asker",
			source: composedFrom("près de", "moi"),
		},
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
