/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Dev-weights linker for `@mailwoman/neural-weights-es-es` (hierarchy campaign R11).
 *
 *   The build itself lives in `scripts/weights-overlay-linker.ts` — this overlay declares
 *   `mailwoman.baseWeights`, so it symlinks nothing and its only job is building the index that makes
 *   `resolveWeights({locale: "es-es"})` surface `pairIndexPath` in local dev.
 *
 *   The index is INERT without the `es` entries in `SEGMENT_PARENT_POSTCODE_SHAPES` and
 *   `LEADING_POSTCODE_COUNTRIES` (`neural/placetype-pair-prior.ts`): Spanish addresses write the
 *   código postal first ("28013 Madrid"), so a parent segment folds to a key no bare-municipio entry
 *   matches.
 */

import { buildPairIndexOverlay } from "../../scripts/weights-overlay-linker.ts"

buildPairIndexOverlay({
	packageDir: "neural-weights-es-es",
	country: "es",
	delta: 10,
	transitionBeta: 5,
})
