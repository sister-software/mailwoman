/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Dev-weights linker for `@mailwoman/neural-weights-de-de` (hierarchy campaign R9).
 *
 *   The build itself lives in `scripts/weights-overlay-linker.ts` — this overlay declares
 *   `mailwoman.baseWeights`, so it symlinks nothing and its only job is building the index that makes
 *   `resolveWeights({locale: "de-de"})` surface `pairIndexPath` in local dev.
 *
 *   The index is INERT without the `de` entries in `SEGMENT_PARENT_POSTCODE_SHAPES` and
 *   `LEADING_POSTCODE_COUNTRIES` (`neural/placetype-pair-prior.ts`): German addresses write the PLZ
 *   first ("50733 Köln"), so a parent segment folds to a key no bare-Gemeinde entry matches. Measured
 *   during R9 — the artifact alone changed nothing until both landed.
 */

import { buildPairIndexOverlay } from "../../scripts/weights-overlay-linker.ts"

buildPairIndexOverlay({
	packageDir: "neural-weights-de-de",
	country: "de",
	// The pair the R9 bars were measured at (0/70 confound FPs, 60/60 tag-correct).
	delta: 10,
	transitionBeta: 5,
})
