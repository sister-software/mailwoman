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
 *   See `docs/engineering/reference/STAGES.md` § Stage 1 for the contract.
 */

export { type AbbreviationEntry, abbreviationDictionary, expandAbbreviations } from "#abbreviations"
export { applyCjkNormalization, type CjkResult } from "#cjk"
export { normalize } from "#compute"
export { foldCaseWhitespace, stripCombiningMarks } from "#fold"
export { applyNFC } from "#nfc"
export { composeMaps, identityMap } from "#offset-map"
export { applyPunctuation } from "#punctuation"
export type { NormalizationTransform, NormalizeOpts, NormalizedInput, SpanRange } from "#types"
export { collapseWhitespace } from "#whitespace"
