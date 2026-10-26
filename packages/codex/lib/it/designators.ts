/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The designators an Italian address uses: the casella postale and fermo posta, the staircase and door words
 *   of the building line, floors, and the relation words of a query.
 *
 *   The building line rows read their designators and source from `unit-line.ts`, and the casella postale row
 *   reads from `casella-postale.ts`. The Poste Italiane document writes the staircase, floor and door as
 *   `scala`, `piano` and `interno` and lists fermo posta in its contents. It lists no abbreviation of them.
 *
 * @see {@link https://business.poste.it/business/files/1476488640071/posta-registrata-caratteristiche-standard-invii.pdf Poste Italiane, Caratteristiche standard degli invii – Posta Registrata (PRS.INDES.STA.1)}
 * @see {@link https://www.upu.int/UPU/media/upu/PostalEntitiesFiles/addressingUnit/itaEn.pdf UPU, Italy addressing sheet}
 * @see {@link https://en.wiktionary.org/wiki/vicino Wiktionary, vicino}
 * @see {@link https://en.wiktionary.org/wiki/accanto Wiktionary, accanto}
 * @see {@link https://it.wikipedia.org/wiki/Casella_postale Wikipedia, Casella postale}
 * @see {@link https://en.wiktionary.org/wiki/building#Translations Wiktionary, building, translations}
 * @see {@link https://en.wiktionary.org/wiki/opposite#Translations Wiktionary, opposite, translations}
 * @see {@link https://en.wiktionary.org/wiki/me Wiktionary, me}
 */

import { IT_CASELLA_POSTALE_RULES, IT_POSTA_REGISTRATA_CITATION } from "#it/casella-postale"
import { IT_UNIT_LINE_RULES } from "#it/unit-line"
import { IT_LEVEL_DESIGNATORS } from "#level-semantics"
import {
	type DesignatorConcept,
	designatorRowsFromLevels,
	type PostalDesignatorRow,
	type PostalDesignatorTable,
} from "#postal-designator"

const WIKTIONARY = "https://en.wiktionary.org/wiki/"

const composedFrom = (near: string, pronoun: string) =>
	`composed from the ${near} row and the first-person pronoun (Wiktionary ${WIKTIONARY}${pronoun})`

const LEVEL_LEXICON = "packages/codex/lib/level-semantics.ts, common building usage with no published authority"

const IT = { script: "Latn", language: "it" } as const

/**
 * The concept of each building line designator that has one outside the floor lexicon.
 *
 * `piano` is a floor, and the lexicon holds it.
 */
const LINE_DESIGNATOR_CONCEPTS: Readonly<Record<string, DesignatorConcept>> = {
	scala: "staircase",
	interno: "door",
}

const lineRows: PostalDesignatorRow[] = IT_UNIT_LINE_RULES.flatMap((rule) => {
	const concept = LINE_DESIGNATOR_CONCEPTS[rule.designator]

	if (!concept) return []

	return [
		{
			...IT,
			spelling: rule.designator,
			abbreviations: [],
			position: "prefix",
			concept,
			source: rule.citation.url,
		},
	]
})

/**
 * Italian postal designators.
 */
export const IT_POSTAL_DESIGNATORS: PostalDesignatorTable = {
	country: "IT",
	rows: [
		// Delivery services.
		{
			...IT,
			spelling: IT_CASELLA_POSTALE_RULES[0].designator,
			abbreviations: ["C.P."],
			position: "prefix",
			concept: "post_office_box",
			source: `${IT_CASELLA_POSTALE_RULES[0].citation.url} and https://it.wikipedia.org/wiki/Casella_postale`,
		},
		{
			...IT,
			spelling: "Fermo posta",
			abbreviations: [],
			position: "standalone",
			concept: "poste_restante",
			source: IT_POSTA_REGISTRATA_CITATION.url,
		},
		// Staircase and door, from the building line.
		...lineRows,
		// Floors.
		...designatorRowsFromLevels(IT_LEVEL_DESIGNATORS, { ...IT, source: LEVEL_LEXICON }),
		// Relation words in a query.
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
		// Premise.
		{
			...IT,
			spelling: "Palazzo",
			abbreviations: [],
			position: "prefix",
			concept: "building",
			source: `${WIKTIONARY}building#Translations`,
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
			...IT,
			spelling: "vicino a me",
			abbreviations: [],
			position: "standalone",
			concept: "near_asker",
			source: composedFrom("vicino a", "me"),
		},
	],
}
