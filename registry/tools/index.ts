/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Registry operator tools — the `run()`-style modules behind `mailwoman registry …` commands. No
 *   argv, no `process.exit`: commands own parsing, rendering, and exit codes (see the 2026-07-09
 *   scripts→Pastel spec). The heavy geocoder is INJECTED via {@link EvalGeocoderFactory} — the
 *   registry package never imports the runtime (`mailwoman` depends on this package, so the reverse
 *   import would cycle). Heavy render deps (playwright/Chromium) are lazy-imported inside their
 *   entry fns.
 */

export * from "./coverage-reconciliation.ts"
export * from "./cross-dataset-correlation.ts"
export * from "./cross-source-threshold-sweep.ts"
export * from "./dedup-ceiling.ts"
export * from "./eval-geocoder.ts"
export * from "./geocoder-namesake-probe.ts"
export * from "./geocoder-vs-provided-coords.ts"
export * from "./gold-set-sample.ts"
export * from "./learned-scorer-clustering-eval.ts"
export * from "./learned-scorer-crossstate-eval.ts"
export * from "./learned-scorer-eval.ts"
export * from "./matcher-scale.ts"
export * from "./nppes-dedup-benchmark.ts"
export * from "./train-cross-gbt.ts"
export * from "./train-gbt.ts"
export * from "./train-org-cross-gbt.ts"
export * from "./txhhsc-to-oarow.ts"
export * from "./viz/cross-dataset-map.ts"
export * from "./viz/geocode-first-surface.ts"
export * from "./viz/render-map.ts"
export * from "./viz/render.ts"
export * from "./viz/source-provenance-map.ts"
export * from "./viz/yardstick-figure.ts"
