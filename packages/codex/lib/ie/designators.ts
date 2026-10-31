/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The designators an Irish address uses: floors and the relation words of a query. The An Post address
 *   sheet on the UPU site lists no delivery service, premise or unit word, so the table has no such row.
 *
 * @see {@link https://www.upu.int/UPU/media/upu/PostalEntitiesFiles/addressingUnit/irlEn.pdf UPU, Ireland addressing sheet}
 * @see {@link https://en.wiktionary.org/wiki/near Wiktionary, near}
 * @see {@link https://en.wiktionary.org/wiki/next_to Wiktionary, next to}
 * @see {@link https://en.wiktionary.org/wiki/beside Wiktionary, beside}
 * @see {@link https://en.wiktionary.org/wiki/opposite Wiktionary, opposite}
 * @see {@link https://en.wiktionary.org/wiki/in Wiktionary, in}
 * @see {@link https://en.wiktionary.org/wiki/at Wiktionary, at}
 * @see {@link https://en.wiktionary.org/wiki/on Wiktionary, on}
 * @see {@link https://www.anpost.com/Post-Parcels/Receiving/Rent-a-PO-Box An Post, Rent a PO Box}
 * @see {@link https://www.anpost.com/Terms-Conditions An Post, Terms and Conditions (Condition 24, PO Boxes)}
 * @see {@link https://en.wiktionary.org/wiki/me Wiktionary, me}
 */

import { EN_LEVEL_DESIGNATORS } from "#level-semantics"
import { designatorRowsFromLevels, type PostalDesignatorTable } from "#postal/designator"

const WIKTIONARY = "https://en.wiktionary.org/wiki/"
const AN_POST_PO_BOX = "https://www.anpost.com/Post-Parcels/Receiving/Rent-a-PO-Box"
const AN_POST_TERMS = "https://www.anpost.com/Terms-Conditions"

const composedFrom = (near: string, pronoun: string) =>
	`composed from the ${near} row and the first-person pronoun (Wiktionary ${WIKTIONARY}${pronoun})`

const LEVEL_LEXICON = "packages/codex/lib/level-semantics.ts, common building usage with no published authority"

const EN = { script: "Latn", language: "en" } as const

/**
 * Irish postal designators.
 */
export const IE_POSTAL_DESIGNATORS: PostalDesignatorTable = {
	country: "IE",
	rows: [
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
			abbreviations: [],
			position: "prefix",
			concept: "post_office_box",
			source: AN_POST_PO_BOX,
		},
		{
			...EN,
			spelling: "Private Bag",
			abbreviations: [],
			position: "prefix",
			concept: "private_bag",
			source: AN_POST_TERMS,
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
