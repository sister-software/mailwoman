// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Dev-weights linker for `@mailwoman/neural-weights-it-it`: it links the files the
 *   package ships, so `resolveWeights({locale: "it-it"})` in local dev reads what a
 *   published install reads, and it builds the index that surfaces `pairIndexPath`.
 *
 *   The index is inert without the `it` entry in `LEADING_POSTCODE_COUNTRIES`
 *   (`neural/pair/prior-windows.ts`): Italian addresses write the CAP first ("00184 Roma"),
 *   so a parent segment folds to a key no bare-comune entry matches.
 */

import {
	committedSoftFeedLinks,
	materializeDevOverlay,
	PAIR_INDEX_DELTA,
	PAIR_INDEX_TRANSITION_BETA,
} from "@mailwoman/resolver-wof-sqlite/weights-overlay-linker"

const softFeed = await committedSoftFeedLinks()

await materializeDevOverlay({
	locale: "it-it",
	model: { kind: "inherit" },
	softFeed: [softFeed.anchor, softFeed.country],
	pairIndex: {
		country: "it",
		delta: PAIR_INDEX_DELTA,
		transitionBeta: PAIR_INDEX_TRANSITION_BETA,
	},
	localeFST: true,
	streetMorphologyFST: true,
})
