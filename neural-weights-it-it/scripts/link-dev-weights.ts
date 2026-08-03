/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Dev-weights linker for `@mailwoman/neural-weights-it-it` (hierarchy campaign R11).
 *
 *   The build itself lives in `scripts/weights-overlay-linker.ts` — this overlay declares
 *   `mailwoman.baseWeights`, so it symlinks nothing and its only job is building the index that makes
 *   `resolveWeights({locale: "it-it"})` surface `pairIndexPath` in local dev.
 *
 *   The index is INERT without the `it` entries in `SEGMENT_PARENT_POSTCODE_SHAPES` and
 *   `LEADING_POSTCODE_COUNTRIES` (`neural/placetype-pair-prior.ts`): Italian addresses write the CAP
 *   first ("00184 Roma"), so a parent segment folds to a key no bare-comune entry matches.
 */

import { buildPairIndexOverlay } from "../../scripts/weights-overlay-linker.ts"

buildPairIndexOverlay({
	packageDir: "neural-weights-it-it",
	country: "it",
	delta: 10,
	transitionBeta: 5,
})
