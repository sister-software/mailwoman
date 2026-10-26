/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The designators a British address uses: the flat and tower words, floors, and the relation words of a
 *   query.
 *
 *   The UPU sheet writes `Stables Flat` and `10B Barry Jackson Tower`. `sub-building.ts` holds the Royal Mail
 *   rules for `Flat` and `Suite` as a Sub Building Name, and this table reads only the flat from the UPU sheet.
 *
 * @see {@link https://www.upu.int/UPU/media/upu/PostalEntitiesFiles/addressingUnit/gbrEn.pdf UPU, United Kingdom addressing sheet}
 * @see {@link https://en.wiktionary.org/wiki/near Wiktionary, near}
 * @see {@link https://en.wiktionary.org/wiki/next_to Wiktionary, next to}
 * @see {@link https://en.wiktionary.org/wiki/beside Wiktionary, beside}
 * @see {@link https://en.wiktionary.org/wiki/opposite Wiktionary, opposite}
 * @see {@link https://en.wiktionary.org/wiki/in Wiktionary, in}
 * @see {@link https://en.wiktionary.org/wiki/at Wiktionary, at}
 * @see {@link https://en.wiktionary.org/wiki/on Wiktionary, on}
 * @see {@link https://en.wiktionary.org/wiki/PO_box Wiktionary, PO box}
 * @see {@link https://en.wiktionary.org/wiki/me Wiktionary, me}
 */

import { EN_LEVEL_DESIGNATORS } from "#level-semantics"
import { designatorRowsFromLevels, type PostalDesignatorTable } from "#postal-designator"

const UPU_UNITED_KINGDOM = "https://www.upu.int/UPU/media/upu/PostalEntitiesFiles/addressingUnit/gbrEn.pdf"
const WIKTIONARY = "https://en.wiktionary.org/wiki/"

const composedFrom = (near: string, pronoun: string) =>
	`composed from the ${near} row and the first-person pronoun (Wiktionary ${WIKTIONARY}${pronoun})`

const LEVEL_LEXICON = "packages/codex/lib/level-semantics.ts, common building usage with no published authority"

const EN = { script: "Latn", language: "en" } as const

/**
 * British postal designators.
 */
export const GB_POSTAL_DESIGNATORS: PostalDesignatorTable = {
	country: "GB",
	rows: [
		// Premise and sub-premise.
		{
			...EN,
			spelling: "Flat",
			abbreviations: [],
			position: "prefix",
			concept: "apartment",
			source: UPU_UNITED_KINGDOM,
		},
		{
			...EN,
			spelling: "Tower",
			abbreviations: [],
			position: "suffix",
			concept: "tower",
			source: UPU_UNITED_KINGDOM,
		},
		// The numbered parts of a transport premise, as in `Gate 12, Terminal 2, Manchester Airport`
		// and `Platform 9¾, King's Cross`.
		{
			...EN,
			spelling: "Terminal",
			abbreviations: [],
			position: "prefix",
			concept: "building",
			source: `${WIKTIONARY}terminal`,
		},
		{
			...EN,
			spelling: "Gate",
			abbreviations: [],
			position: "prefix",
			concept: "unit",
			source: `${WIKTIONARY}gate`,
		},
		{
			...EN,
			spelling: "Platform",
			abbreviations: [],
			position: "prefix",
			concept: "unit",
			source: `${WIKTIONARY}platform`,
		},
		// Floors.
		...designatorRowsFromLevels(EN_LEVEL_DESIGNATORS, { ...EN, source: LEVEL_LEXICON }),
		// Relation words in a query.
		{
			...EN,
			spelling: "near",
			abbreviations: [],
			position: "prefix",
			concept: "near",
			source: `${WIKTIONARY}near`,
		},
		{
			...EN,
			spelling: "next to",
			abbreviations: [],
			position: "prefix",
			concept: "beside",
			source: `${WIKTIONARY}next_to`,
		},
		{
			...EN,
			spelling: "beside",
			abbreviations: [],
			position: "prefix",
			concept: "beside",
			source: `${WIKTIONARY}beside`,
		},
		{
			...EN,
			spelling: "opposite",
			abbreviations: [],
			position: "prefix",
			concept: "opposite",
			source: `${WIKTIONARY}opposite`,
		},
		{
			...EN,
			spelling: "in",
			abbreviations: [],
			position: "prefix",
			concept: "in",
			source: `${WIKTIONARY}in`,
		},
		{
			...EN,
			spelling: "at",
			abbreviations: [],
			position: "prefix",
			concept: "at",
			source: `${WIKTIONARY}at`,
		},
		{
			...EN,
			spelling: "on",
			abbreviations: [],
			position: "prefix",
			concept: "on",
			source: `${WIKTIONARY}on`,
		},
		// Delivery services.
		{
			...EN,
			spelling: "PO Box",
			abbreviations: ["P.O. Box"],
			position: "prefix",
			concept: "post_office_box",
			source: `${WIKTIONARY}PO_box`,
		},
		// Near the asker.
		{
			...EN,
			spelling: "near me",
			abbreviations: [],
			position: "standalone",
			concept: "near_asker",
			source: composedFrom("near", "me"),
		},
	],
}
