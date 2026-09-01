/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Coarse-placer (#244) operator tools — the `run()`-style modules behind `mailwoman placer …`
 *   commands. No argv, no `process.exit`: commands own
 *   parsing, rendering, and exit codes. Heavy deps that are core devDependencies
 *   (`@duckdb/node-api`, `@mailwoman/codex`) are lazy-imported inside their entry fns. `country-sets.ts`,
 *   `paths.ts`, and `outlier-rows.ts` are deliberately NOT re-exported — they are internal to the tools;
 *   `fnv-hash.ts` lives at the coarse-placer root because `featurize` hashes through it.
 */

export * from "#coarse-placer/tools/build-dataset"
export * from "#coarse-placer/tools/build-outlier-exposure"
export * from "#coarse-placer/tools/build-outlier-latin"
export * from "#coarse-placer/tools/build-outlier-oa"
export * from "#coarse-placer/tools/eval"
export * from "#coarse-placer/tools/eval-latin-offmap"
export * from "#coarse-placer/tools/eval-openset"
export * from "#coarse-placer/tools/eval-quant-compare"
export * from "#coarse-placer/tools/probe-frontier"
export * from "#coarse-placer/tools/quantize"
export * from "#coarse-placer/tools/train"
