/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Dev-weights linker for `@mailwoman/neural-weights-en-in` (hierarchy campaign R10).
 *
 *   The build itself lives in `@mailwoman/resolver-wof-sqlite/weights-overlay-linker` — this overlay declares
 *   `mailwoman.baseWeights`, so it symlinks nothing and its only job is building the index that makes
 *   `resolveWeights({locale: "en-in"})` surface `pairIndexPath` in local dev.
 *
 *   Note the country code is `in`, not the locale tag: this builds `pair-index-in.bin`.
 *
 *   Indian addresses put the PIN last ("Indiranagar, Bengaluru 560038"), so unlike the FR/DE/ES/IT
 *   instances this locale needs no `LEADING_POSTCODE_COUNTRIES` entry — the existing trailing-postcode
 *   strip already folds the parent segment to a bare-city key. Its absence from that set is deliberate
 *   and should not be "completed".
 *
 *   THE FILE THIS BUILDS IS THE PACKAGE'S ENTIRE PAYLOAD. It is gitignored (derived), and a workspace
 *   that has never run this script packs to three metadata files describing an artifact that is not
 *   there — which is exactly how v8.6.0 shipped. `packages/release-kit/lib/pack/verify-tarball.ts` now refuses that publish,
 *   but the fix is to run this first.
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
