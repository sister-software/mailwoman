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
 *   See `docs/engineering/reference/stages.md` § Stage 1 for the interface.
 */

export * from "#abbreviations"
export * from "#cjk"
export * from "#compute"
export * from "#fold"
export * from "#nfc"
export * from "#offset-map"
export * from "#punctuation"
export * from "#types"
export * from "#whitespace"
