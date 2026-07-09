/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Coarse-placer (#244) operator tools — the `run()`-style modules behind `mailwoman placer …`
 *   commands (see the 2026-07-09 scripts→Pastel spec). No argv, no `process.exit`: commands own
 *   parsing, rendering, and exit codes. Heavy deps that are core devDependencies
 *   (`@duckdb/node-api`, `@mailwoman/codex`) are lazy-imported inside their entry fns. `fnv-hash.ts`
 *   is deliberately NOT re-exported — it's internal to the dataset builders.
 */

export * from "./build-dataset.ts"
export * from "./build-outlier-exposure.ts"
export * from "./build-outlier-latin.ts"
export * from "./build-outlier-oa.ts"
export * from "./eval.ts"
export * from "./eval-latin-offmap.ts"
export * from "./eval-openset.ts"
export * from "./eval-quant-compare.ts"
export * from "./probe-frontier.ts"
export * from "./quantize.ts"
export * from "./train.ts"
