/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The designators a French address uses: delivery services, premise and sub-premise words, floors, the
 *   number mark, and the relation words of a query.
 *
 *   The premise words come from the line 2 and line 3 rules in `unit-line.ts`, which cite La Poste's SP 8855.
 *   The `CEDEX` row stands for the phrase that `cedex.ts` matches.
 *
 * @see {@link https://www.laposte.fr/envoyer/abreviation-adresses-postales La Poste, Abréviations des adresses postales}
 * @see {@link https://www.upu.int/UPU/media/upu/PostalEntitiesFiles/addressingUnit/fraEn.pdf UPU, France addressing sheet}
 * @see {@link https://lastation.laposte.fr/sites/p8_u1/files/2026-07/SP8855-Volume%202_V1.14%20-%20Adressage%20des%20plis.pdf La Poste, SP 8855 Volume 2, Adressage des plis (v1.14)}
 * @see {@link https://en.wiktionary.org/wiki/près_de Wiktionary, près de}
 * @see {@link https://en.wiktionary.org/wiki/à_côté_de Wiktionary, à côté de}
 * @see {@link https://en.wiktionary.org/wiki/en_face_de Wiktionary, en face de}
 * @see {@link https://en.wiktionary.org/wiki/dans Wiktionary, dans}
 * @see {@link https://en.wiktionary.org/wiki/moi Wiktionary, moi}
 */

import { FR_UNIT_LINE_RULES } from "#fr/unit-line"
import { FR_LEVEL_DESIGNATORS } from "#level-semantics"
import {
	type DesignatorConcept,
	designatorRowsFromLevels,
	type PostalDesignatorRow,
	type PostalDesignatorTable,
} from "#postal/designator"

const LA_POSTE_ABBREVIATIONS = "https://www.laposte.fr/envoyer/abreviation-adresses-postales"
const UPU_FRANCE = "https://www.upu.int/UPU/media/upu/PostalEntitiesFiles/addressingUnit/fraEn.pdf"

const SP_8855 =
	"https://lastation.laposte.fr/sites/p8_u1/files/2026-07/SP8855-Volume%202_V1.14%20-%20Adressage%20des%20plis.pdf"

const WIKTIONARY = "https://en.wiktionary.org/wiki/"

const composedFrom = (near: string, pronoun: string) =>
	`composed from the ${near} row and the first-person pronoun (Wiktionary ${WIKTIONARY}${pronoun})`

const LEVEL_LEXICON = "packages/codex/lib/level-semantics.ts, common building usage with no published authority"

const FR = { script: "Latn", language: "fr" } as const

/**
 * The concept of each line 2 and line 3 designator that has one.
 *
 * `BAL`, `COULOIR` and `LOTISSEMENT` have none here.
 * The floor lexicon holds `ETAGE`.
 */
const LINE_DESIGNATOR_CONCEPTS: Readonly<Record<string, DesignatorConcept>> = {
	APPARTEMENT: "apartment",
	ENTREE: "entrance",
	BATIMENT: "building",
	IMMEUBLE: "building",
	RESIDENCE: "building",
	TOUR: "tower",
	ESCALIER: "staircase",
}

/**
 * The abbreviations La Poste's word tables give for each line designator.
 */
const LINE_DESIGNATOR_ABBREVIATIONS: Readonly<Record<string, readonly string[]>> = {
	APPARTEMENT: ["APP", "App."],
	ENTREE: ["ENT"],
	BATIMENT: ["BAT", "Bât."],
	IMMEUBLE: ["IMM", "Imm."],
	RESIDENCE: ["RES", "Rés."],
	ESCALIER: ["ESCA", "Esc."],
}

const lineRows: PostalDesignatorRow[] = FR_UNIT_LINE_RULES.flatMap((rule) => {
	const concept = LINE_DESIGNATOR_CONCEPTS[rule.designator]

	if (!concept) return []

	const abbreviations = LINE_DESIGNATOR_ABBREVIATIONS[rule.designator] ?? []

	return [
		{
			...FR,
			spelling: rule.designator,
			abbreviations,
			position: "prefix",
			concept,
			source: abbreviations.length ? `${rule.citation.url} and ${LA_POSTE_ABBREVIATIONS}` : rule.citation.url,
		},
	]
})

/**
 * French postal designators.
 */
export const FR_POSTAL_DESIGNATORS: PostalDesignatorTable = {
	country: "FR",
	rows: [
		// Delivery services.
		{
			...FR,
			spelling: "Boîte postale",
			abbreviations: ["BP", "B.P."],
			position: "prefix",
			concept: "post_office_box",
			source: LA_POSTE_ABBREVIATIONS,
		},
		{
			...FR,
			spelling: "Case postale",
			abbreviations: ["CP"],
			position: "prefix",
			concept: "post_office_box",
			source: LA_POSTE_ABBREVIATIONS,
		},
		{
			...FR,
			spelling: "Poste restante",
			abbreviations: [],
			position: "standalone",
			concept: "poste_restante",
			source: UPU_FRANCE,
		},
		{
			...FR,
			spelling: "CEDEX",
			abbreviations: [],
			position: "suffix",
			concept: "special_routing",
			source: UPU_FRANCE,
		},
		{
			...FR,
			spelling: "Course spéciale",
			abbreviations: ["CS"],
			position: "prefix",
			concept: "special_routing",
			source: LA_POSTE_ABBREVIATIONS,
		},
		{
			...FR,
			spelling: "Tri service arrivée",
			abbreviations: ["TSA"],
			position: "prefix",
			concept: "special_routing",
			source: LA_POSTE_ABBREVIATIONS,
		},
		// Premise and apartment, from the SP 8855 line 2 and line 3 rules.
		...lineRows,
		// Sub-premise.
		{
			...FR,
			spelling: "Bureau",
			abbreviations: ["Bur."],
			position: "prefix",
			concept: "office",
			source: LA_POSTE_ABBREVIATIONS,
		},
		{
			...FR,
			spelling: "Cabinet",
			abbreviations: ["CAB"],
			position: "prefix",
			concept: "office",
			source: LA_POSTE_ABBREVIATIONS,
		},
		{
			...FR,
			spelling: "Chambre",
			abbreviations: ["CHBR"],
			position: "prefix",
			concept: "room",
			source: LA_POSTE_ABBREVIATIONS,
		},
		// Floors: the shared lexicon, then the abbreviation La Poste lists that the lexicon lacks.
		...designatorRowsFromLevels(FR_LEVEL_DESIGNATORS, { ...FR, source: LEVEL_LEXICON }),
		{
			...FR,
			spelling: "ETG",
			abbreviations: [],
			position: "prefix",
			concept: "floor",
			source: LA_POSTE_ABBREVIATIONS,
		},
		// Number mark.
		{
			...FR,
			spelling: "N°",
			abbreviations: ["Nº", "No"],
			position: "prefix",
			concept: "number_sign",
			source: SP_8855,
		},
		// Relation words in a query.
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
		// Near the asker.
		{
			...FR,
			spelling: "près de moi",
			abbreviations: [],
			position: "standalone",
			concept: "near_asker",
			source: composedFrom("près de", "moi"),
		},
	],
}
