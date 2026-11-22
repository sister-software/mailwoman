// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Dev-weights linker for `@mailwoman/neural-weights-en-in`: it links the files the package ships,
 *   so `resolveWeights({locale: "en-in"})` in local dev reads what a published install reads.
 *
 *   The country code is `in`, not the locale tag, so this builds `pair-index-in.bin`.
 *   The package ships no per-locale FST.
 *
 *   Indian addresses put the PIN last ("Indiranagar, Bengaluru 560038"), so this locale
 *   needs no `LEADING_POSTCODE_COUNTRIES` entry — the trailing-postcode strip already folds
 *   the parent segment to a bare-city key — and its absence from that set is deliberate.
 */

import {
	committedSoftFeedLinks,
	materializeDevOverlay,
	PAIR_INDEX_DELTA,
	PAIR_INDEX_TRANSITION_BETA,
} from "@mailwoman/resolver-wof-sqlite/weights/overlay-linker"

const softFeed = await committedSoftFeedLinks()

await materializeDevOverlay({
	locale: "en-in",
	model: { kind: "inherit" },
	softFeed: [softFeed.anchor, softFeed.country],
	pairIndex: {
		country: "in",
		delta: PAIR_INDEX_DELTA,
		transitionBeta: PAIR_INDEX_TRANSITION_BETA,
	},
	streetMorphologyFST: true,
})
