/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `@mailwoman/normalize` — Stage 1 of the runtime pipeline.
 *
 *   Deterministic input preprocessing: NFC, punctuation, whitespace, optional case-fold +
 *   abbreviation expansion. Pure functions. Produces a `NormalizedInput` with a critical
 *   `offsetMap` so downstream stages can map normalized-string spans back to raw-string character
 *   offsets.
 *
 *   See `docs/articles/plan/reference/STAGES.md` § Stage 1 for the contract.
 */

export { type AbbreviationEntry, abbreviationDictionary, expandAbbreviations } from "./abbreviations.ts"
export { applyCjkNormalization, type CjkResult } from "./cjk.ts"
export { normalize } from "./compute.ts"
export { applyNFC } from "./nfc.ts"
export { composeMaps, identityMap } from "./offset-map.ts"
export { applyPunctuation } from "./punctuation.ts"
export type { NormalizationTransform, NormalizeOpts, NormalizedInput, SpanRange } from "./types.ts"
export { collapseWhitespace } from "./whitespace.ts"
