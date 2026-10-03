// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file POI board expectation variants.
 */

export interface POIBoardResultsExpect {
	kind: "results"
	/**
	 * Exactly one of `categoryID` / `brandWikidata` is set per fixture —
	 * the grader checks the top result's matching field.
	 *
	 * `brandWikidata` cases (part 2 of the brand-lexicon work) assert the top result's
	 * `POIResult.brandWikidata` equals this QID; `categoryID` cases are unchanged from v1.
	 */
	categoryID?: string
	brandWikidata?: string
	anchorGold: { latitude: number; longitude: number }
	maxNearestKm: number
}

export interface POIBoardAbstainExpect {
	kind: "abstain"
	reason: string
}

export interface POIBoardAddressExpect {
	kind: "address"
}

export type POIBoardExpect = POIBoardResultsExpect | POIBoardAbstainExpect | POIBoardAddressExpect
