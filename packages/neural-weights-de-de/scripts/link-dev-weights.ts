/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Dev-weights linker for `@mailwoman/neural-weights-de-de`: it builds the index that makes
 *   `resolveWeights({locale: "de-de"})` surface `pairIndexPath` in local dev.
 *
 *   The index is inert without the `de` entries in `SEGMENT_PARENT_POSTCODE_SHAPES` and
 *   `LEADING_POSTCODE_COUNTRIES` (`neural/placetype-pair-prior.ts`): German addresses write the PLZ
 *   first ("50733 Köln"), so a parent segment folds to a key no bare-Gemeinde entry matches.
 */

import {
	materializeDevOverlay,
	PAIR_INDEX_DELTA,
	PAIR_INDEX_TRANSITION_BETA,
} from "@mailwoman/resolver-wof-sqlite/weights-overlay-linker"

await materializeDevOverlay({
	locale: "de-de",
	pairIndex: {
		country: "de",
		delta: PAIR_INDEX_DELTA,
		transitionBeta: PAIR_INDEX_TRANSITION_BETA,
	},
})
