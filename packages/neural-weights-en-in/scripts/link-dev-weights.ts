/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Dev-weights linker for `@mailwoman/neural-weights-en-in`: the country code is `in`, not the locale
 *   tag, so this builds `pair-index-in.bin`.
 *
 *   Indian addresses put the PIN last ("Indiranagar, Bengaluru 560038"), so this locale needs no
 *   `LEADING_POSTCODE_COUNTRIES` entry — the trailing-postcode strip already folds the parent segment
 *   to a bare-city key — and its absence from that set is deliberate.
 */

import {
	materializeDevOverlay,
	PAIR_INDEX_DELTA,
	PAIR_INDEX_TRANSITION_BETA,
} from "@mailwoman/resolver-wof-sqlite/weights-overlay-linker"

await materializeDevOverlay({
	locale: "en-in",
	pairIndex: {
		country: "in",
		delta: PAIR_INDEX_DELTA,
		transitionBeta: PAIR_INDEX_TRANSITION_BETA,
	},
})
