// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Dev-weights linker for `@mailwoman/neural-weights-de-de`: it links the files the
 *   package ships, so `resolveWeights({locale: "de-de"})` in local dev reads what a
 *   published install reads, and it builds the index that surfaces `pairIndexPath`.
 *
 *   The index is inert without the `de` entry in `LEADING_POSTCODE_COUNTRIES`
 *   (`neural/pair/prior-windows.ts`): German addresses write the PLZ first ("50733 Köln"),
 *   so a parent segment folds to a key no bare-Gemeinde entry matches.
 */

import {
	committedSoftFeedLinks,
	materializeDevOverlay,
	PAIR_INDEX_DELTA,
	PAIR_INDEX_TRANSITION_BETA,
} from "@mailwoman/resolver-wof-sqlite/weights-overlay-linker"

const softFeed = await committedSoftFeedLinks()

await materializeDevOverlay({
	locale: "de-de",
	model: { kind: "inherit" },
	softFeed: [softFeed.anchor, softFeed.country],
	pairIndex: {
		country: "de",
		delta: PAIR_INDEX_DELTA,
		transitionBeta: PAIR_INDEX_TRANSITION_BETA,
	},
	localeFST: true,
	streetMorphologyFST: true,
})
