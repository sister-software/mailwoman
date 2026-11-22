// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Dev-weights linker for `@mailwoman/neural-weights-es-es`: it links the files the
 *   package ships, so `resolveWeights({locale: "es-es"})` in local dev reads what a
 *   published install reads, and it builds the index that surfaces `pairIndexPath`.
 *
 *   The index is inert without the `es` entry in `LEADING_POSTCODE_COUNTRIES`
 *   (`neural/pair/prior-windows.ts`): Spanish addresses write the código postal first
 *   ("28013 Madrid"), so a parent segment folds to a key no bare-municipio entry matches.
 */

import {
	committedSoftFeedLinks,
	materializeDevOverlay,
	PAIR_INDEX_DELTA,
	PAIR_INDEX_TRANSITION_BETA,
} from "@mailwoman/resolver-wof-sqlite/weights/overlay-linker"

const softFeed = await committedSoftFeedLinks()

await materializeDevOverlay({
	locale: "es-es",
	model: { kind: "inherit" },
	softFeed: [softFeed.anchor, softFeed.country],
	pairIndex: {
		country: "es",
		delta: PAIR_INDEX_DELTA,
		transitionBeta: PAIR_INDEX_TRANSITION_BETA,
	},
	localeFST: true,
	streetMorphologyFST: true,
})
