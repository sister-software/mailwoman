/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The designators a Portuguese address uses: the apartado and private letter box, the door side, floors,
 *   the number and ordinal marks, and the relation words of a query.
 *
 *   The UPU sheet writes `R. LEAL DA CÂMARA 31 RC ESQ`, `APARTADO 42024` and `CCI 8318`, and it labels the `CCI`
 *   line a p.o. box. The marks `n.º`, `º` and `ª` are read from Wiktionary, because the sheet's examples write
 *   none of them.
 *
 * @see {@link https://www.upu.int/UPU/media/upu/PostalEntitiesFiles/addressingUnit/prtEn.pdf UPU, Portugal addressing sheet}
 * @see {@link https://en.wiktionary.org/wiki/nº Wiktionary, nº}
 * @see {@link https://en.wiktionary.org/wiki/º Wiktionary, º}
 * @see {@link https://en.wiktionary.org/wiki/ª Wiktionary, ª}
 * @see {@link https://en.wiktionary.org/wiki/perto_de Wiktionary, perto de}
 * @see {@link https://en.wiktionary.org/wiki/next_to#Translations Wiktionary, next to, translations}
 * @see {@link https://en.wiktionary.org/wiki/opposite#Translations Wiktionary, opposite, translations}
 * @see {@link https://en.wiktionary.org/wiki/mim Wiktionary, mim}
 */

import { PT_LEVEL_DESIGNATORS } from "#level-semantics"
import { designatorRowsFromLevels, type PostalDesignatorTable } from "#postal/designator"

const UPU_PORTUGAL = "https://www.upu.int/UPU/media/upu/PostalEntitiesFiles/addressingUnit/prtEn.pdf"
const WIKTIONARY = "https://en.wiktionary.org/wiki/"

const composedFrom = (near: string, pronoun: string) =>
	`composed from the ${near} row and the first-person pronoun (Wiktionary ${WIKTIONARY}${pronoun})`

const LEVEL_LEXICON = "packages/codex/lib/level-semantics.ts, common building usage with no published authority"

const PT = { script: "Latn", language: "pt" } as const

/**
 * Portuguese postal designators.
 */
export const PT_POSTAL_DESIGNATORS: PostalDesignatorTable = {
	country: "PT",
	rows: [
		// Delivery services.
		{
			...PT,
			spelling: "Apartado",
			abbreviations: [],
			position: "prefix",
			concept: "post_office_box",
			source: UPU_PORTUGAL,
		},
		{
			...PT,
			spelling: "CCI",
			abbreviations: [],
			position: "prefix",
			concept: "post_office_box",
			source: UPU_PORTUGAL,
		},
		// Door side, as in `31 RC ESQ`.
		{
			...PT,
			spelling: "ESQ",
			abbreviations: [],
			position: "suffix",
			concept: "door",
			source: UPU_PORTUGAL,
		},
		// Floors.
		...designatorRowsFromLevels(PT_LEVEL_DESIGNATORS, { ...PT, source: LEVEL_LEXICON }),
		// Number and ordinal marks.
		{
			...PT,
			spelling: "n.º",
			abbreviations: ["nº"],
			position: "prefix",
			concept: "number_sign",
			source: `${WIKTIONARY}nº`,
		},
		{
			...PT,
			spelling: "º",
			abbreviations: [],
			position: "suffix",
			concept: "ordinal_mark",
			source: `${WIKTIONARY}º`,
		},
		{
			...PT,
			spelling: "ª",
			abbreviations: [],
			position: "suffix",
			concept: "ordinal_mark",
			source: `${WIKTIONARY}ª`,
		},
		// Relation words in a query.
		{
			...PT,
			spelling: "perto de",
			abbreviations: [],
			position: "prefix",
			concept: "near",
			source: `${WIKTIONARY}perto_de`,
		},
		{
			...PT,
			spelling: "ao lado de",
			abbreviations: [],
			position: "prefix",
			concept: "beside",
			source: `${WIKTIONARY}next_to#Translations`,
		},
		{
			...PT,
			spelling: "na frente de",
			abbreviations: [],
			position: "prefix",
			concept: "opposite",
			source: `${WIKTIONARY}opposite#Translations`,
		},
		// Near the asker.
		{
			...PT,
			spelling: "perto de mim",
			abbreviations: [],
			position: "standalone",
			concept: "near_asker",
			source: composedFrom("perto de", "mim"),
		},
	],
}
