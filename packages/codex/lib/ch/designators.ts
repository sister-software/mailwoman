/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The designators a Swiss address uses, in German, French and Italian: the Postfach and case postale, the
 *   floors of each language, and the relation words of a query.
 *
 *   The Italian casella postale reads from the Italian Wikipedia article, and the Romansh forms have no row.
 *
 * @see {@link https://www.upu.int/UPU/media/upu/PostalEntitiesFiles/addressingUnit/cheEn.pdf UPU, Switzerland addressing sheet}
 * @see {@link https://www.post.ch/de/briefe-versenden/adressieren-und-gestalten/sendungen-richtig-adressieren Swiss Post, Sendungen richtig adressieren}
 * @see {@link https://en.wiktionary.org/wiki/in_der_Nähe Wiktionary, in der Nähe}
 * @see {@link https://en.wiktionary.org/wiki/bei Wiktionary, bei}
 * @see {@link https://en.wiktionary.org/wiki/neben Wiktionary, neben}
 * @see {@link https://en.wiktionary.org/wiki/gegenüber Wiktionary, gegenüber}
 * @see {@link https://en.wiktionary.org/wiki/près_de Wiktionary, près de}
 * @see {@link https://en.wiktionary.org/wiki/à_côté_de Wiktionary, à côté de}
 * @see {@link https://en.wiktionary.org/wiki/en_face_de Wiktionary, en face de}
 * @see {@link https://en.wiktionary.org/wiki/vicino Wiktionary, vicino}
 * @see {@link https://en.wiktionary.org/wiki/accanto Wiktionary, accanto}
 * @see {@link https://it.wikipedia.org/wiki/Casella_postale Wikipedia, Casella postale}
 * @see {@link https://en.wiktionary.org/wiki/apartment#Translations Wiktionary, apartment, translations}
 * @see {@link https://en.wiktionary.org/wiki/Whg. Wiktionary, Whg.}
 * @see {@link https://en.wiktionary.org/wiki/building#Translations Wiktionary, building, translations}
 * @see {@link https://en.wiktionary.org/wiki/entrance#Translations Wiktionary, entrance, translations}
 * @see {@link https://en.wiktionary.org/wiki/Aufgang Wiktionary, Aufgang}
 * @see {@link https://en.wiktionary.org/wiki/opposite#Translations Wiktionary, opposite, translations}
 * @see {@link https://en.wiktionary.org/wiki/moi Wiktionary, moi}
 * @see {@link https://en.wiktionary.org/wiki/meiner Wiktionary, meiner}
 * @see {@link https://en.wiktionary.org/wiki/me Wiktionary, me}
 */

import { DE_LEVEL_DESIGNATORS, FR_LEVEL_DESIGNATORS, IT_LEVEL_DESIGNATORS } from "#level-semantics"
import { designatorRowsFromLevels, type PostalDesignatorTable } from "#postal/designator"

const UPU_SWITZERLAND = "https://www.upu.int/UPU/media/upu/PostalEntitiesFiles/addressingUnit/cheEn.pdf"

const SWISS_POST_ADDRESSING =
	"https://www.post.ch/de/briefe-versenden/adressieren-und-gestalten/sendungen-richtig-adressieren"

const WIKTIONARY = "https://en.wiktionary.org/wiki/"

const composedFrom = (near: string, pronoun: string) =>
	`composed from the ${near} row and the first-person pronoun (Wiktionary ${WIKTIONARY}${pronoun})`

const LEVEL_LEXICON = "packages/codex/lib/level-semantics.ts, common building usage with no published authority"

const DE = { script: "Latn", language: "de" } as const
const FR = { script: "Latn", language: "fr" } as const
const IT = { script: "Latn", language: "it" } as const

/**
 * Swiss postal designators.
 */
export const CH_POSTAL_DESIGNATORS: PostalDesignatorTable = {
	country: "CH",
	rows: [
		// Delivery services.
		{
			...DE,
			spelling: "Postfach",
			abbreviations: [],
			position: "prefix",
			concept: "post_office_box",
			source: SWISS_POST_ADDRESSING,
		},
		{
			...FR,
			spelling: "Case postale",
			abbreviations: [],
			position: "prefix",
			concept: "post_office_box",
			source: UPU_SWITZERLAND,
		},
		// Floors.
		...designatorRowsFromLevels(DE_LEVEL_DESIGNATORS, { ...DE, source: LEVEL_LEXICON }),
		...designatorRowsFromLevels(FR_LEVEL_DESIGNATORS, { ...FR, source: LEVEL_LEXICON }),
		...designatorRowsFromLevels(IT_LEVEL_DESIGNATORS, { ...IT, source: LEVEL_LEXICON }),
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
		// Relation words in a query, Italian.
		{
			...IT,
			spelling: "vicino a",
			abbreviations: [],
			position: "prefix",
			concept: "near",
			source: `${WIKTIONARY}vicino`,
		},
		{
			...IT,
			spelling: "accanto a",
			abbreviations: [],
			position: "prefix",
			concept: "beside",
			source: `${WIKTIONARY}accanto`,
		},
		// Delivery services and premise words added from the language's own references.
		{
			...IT,
			spelling: "Casella postale",
			abbreviations: ["C.P."],
			position: "prefix",
			concept: "post_office_box",
			source: "https://it.wikipedia.org/wiki/Casella_postale",
		},
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
			...IT,
			spelling: "di fronte a",
			abbreviations: [],
			position: "prefix",
			concept: "opposite",
			source: `${WIKTIONARY}opposite#Translations`,
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
		{
			...IT,
			spelling: "vicino a me",
			abbreviations: [],
			position: "standalone",
			concept: "near_asker",
			source: composedFrom("vicino a", "me"),
		},
	],
}
