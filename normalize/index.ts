/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `@mailwoman/normalize` — Stage 1 of the runtime pipeline.
 *
 *   Deterministic input preprocessing: NFC, punctuation, whitespace, optional case-fold +
 *   abbreviation expansion. Pure functions. Produces a `NormalizedInput` with a load-bearing
 *   `offsetMap` so downstream stages can map normalized-string spans back to raw-string character
 *   offsets.
 *
 *   See `docs/articles/plan/reference/STAGES.md` § Stage 1 for the contract.
 */

export { expandAbbreviations } from "./abbreviations.js"
export { normalize } from "./compute.js"
export { applyNfc } from "./nfc.js"
export { composeMaps, identityMap } from "./offset-map.js"
export { applyPunctuation } from "./punctuation.js"
export type { NormalizationTransform, NormalizeOpts, NormalizedInput, SpanRange } from "./types.js"
export { collapseWhitespace } from "./whitespace.js"
