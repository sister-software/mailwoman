/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The designators a Spanish address uses: the apartado, building and staircase words, floors, the ordinal
 *   marks, and the relation words of a query.
 *
 *   The UPU sheet writes `Plaza de las Descalzas 27, Esc 2, 3º, C` and `Edificio Lepanto`. The feminine mark
 *   `ª` is read from Wiktionary, because the sheet's examples write the masculine mark only.
 *
 * @see {@link https://www.upu.int/UPU/media/upu/PostalEntitiesFiles/addressingUnit/espEn.pdf UPU, Spain addressing sheet}
 * @see {@link https://en.wiktionary.org/wiki/ª Wiktionary, ª}
 * @see {@link https://en.wiktionary.org/wiki/cerca_de Wiktionary, cerca de}
 * @see {@link https://en.wiktionary.org/wiki/junto_a Wiktionary, junto a}
 * @see {@link https://en.wiktionary.org/wiki/frente_a Wiktionary, frente a}
 * @see {@link https://epostal.correos.es/OV2PREENVWEB/plantillas/GuiadeAyuda.pdf Correos, Guía de Ayuda, Formato de Fichero Único}
 * @see {@link https://es.wikipedia.org/wiki/Apartado_de_correos Wikipedia, Apartado de correos}
 * @see {@link https://en.wiktionary.org/wiki/mí Wiktionary, mí}
 */

import { ES_LEVEL_DESIGNATORS } from "#level-semantics"
import { designatorRowsFromLevels, type PostalDesignatorTable } from "#postal-designator"

const UPU_SPAIN = "https://www.upu.int/UPU/media/upu/PostalEntitiesFiles/addressingUnit/espEn.pdf"
const WIKTIONARY = "https://en.wiktionary.org/wiki/"
const CORREOS_FIELDS = "https://epostal.correos.es/OV2PREENVWEB/plantillas/GuiadeAyuda.pdf"

const composedFrom = (near: string, pronoun: string) =>
	`composed from the ${near} row and the first-person pronoun (Wiktionary ${WIKTIONARY}${pronoun})`

const LEVEL_LEXICON = "packages/codex/lib/level-semantics.ts, common building usage with no published authority"

const ES = { script: "Latn", language: "es" } as const

/**
 * Spanish postal designators.
 */
export const ES_POSTAL_DESIGNATORS: PostalDesignatorTable = {
	country: "ES",
	rows: [
		// Delivery services.
		{
			...ES,
			spelling: "Apartado",
			abbreviations: [],
			position: "prefix",
			concept: "post_office_box",
			source: UPU_SPAIN,
		},
		// Premise.
		{
			...ES,
			spelling: "Edificio",
			abbreviations: [],
			position: "prefix",
			concept: "building",
			source: UPU_SPAIN,
		},
		{
			...ES,
			spelling: "Escalera",
			abbreviations: ["Esc"],
			position: "prefix",
			concept: "staircase",
			source: `${UPU_SPAIN} and ${CORREOS_FIELDS}`,
		},
		{
			...ES,
			spelling: "Portal",
			abbreviations: [],
			position: "prefix",
			concept: "entrance",
			source: CORREOS_FIELDS,
		},
		{
			...ES,
			spelling: "Bloque",
			abbreviations: [],
			position: "prefix",
			concept: "block",
			source: CORREOS_FIELDS,
		},
		// Sub-premise.
		{
			...ES,
			spelling: "Puerta",
			abbreviations: [],
			position: "prefix",
			concept: "door",
			source: CORREOS_FIELDS,
		},
		// Floors.
		...designatorRowsFromLevels(ES_LEVEL_DESIGNATORS, { ...ES, source: LEVEL_LEXICON }),
		// Ordinal marks.
		{
			...ES,
			spelling: "º",
			abbreviations: [],
			position: "suffix",
			concept: "ordinal_mark",
			source: UPU_SPAIN,
		},
		{
			...ES,
			spelling: "ª",
			abbreviations: [],
			position: "suffix",
			concept: "ordinal_mark",
			source: `${WIKTIONARY}ª`,
		},
		// Relation words in a query.
		{
			...ES,
			spelling: "cerca de",
			abbreviations: [],
			position: "prefix",
			concept: "near",
			source: `${WIKTIONARY}cerca_de`,
		},
		{
			...ES,
			spelling: "junto a",
			abbreviations: [],
			position: "prefix",
			concept: "beside",
			source: `${WIKTIONARY}junto_a`,
		},
		{
			...ES,
			spelling: "frente a",
			abbreviations: [],
			position: "prefix",
			concept: "opposite",
			source: `${WIKTIONARY}frente_a`,
		},
		// Further delivery service spellings and the number mark.
		{
			...ES,
			spelling: "Apartado de correos",
			abbreviations: ["Apartado postal"],
			position: "prefix",
			concept: "post_office_box",
			source: "https://es.wikipedia.org/wiki/Apartado_de_correos",
		},
		{
			...ES,
			spelling: "Nº",
			abbreviations: [],
			position: "prefix",
			concept: "number_sign",
			source: CORREOS_FIELDS,
		},
		// Near the asker.
		{
			...ES,
			spelling: "cerca de mí",
			abbreviations: [],
			position: "standalone",
			concept: "near_asker",
			source: composedFrom("cerca de", "mí"),
		},
	],
}
