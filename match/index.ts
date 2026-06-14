/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `@mailwoman/match` — the geocode-first record matcher: block → score → cluster.
 *
 *   Built: geo-first {@link block blocking} (candidate generation) → the scoring stage's string
 *   {@link jaroWinkler comparators} → the {@link scorePair Fellegi-Sunter} weight model (agreement
 *   levels → `log2(m/u)` weights → probability → link / review / non-link), with `m`/`u` learned
 *   label-free by {@link estimateParameters EM} and rare-value agreement up-weighted by
 *   {@link withTermFrequency term frequency}. Still to land: centroid-linkage clustering (pairwise
 *   scores are non-transitive) into canonical entities.
 */

export * from "./blocking.js"
export * from "./comparators.js"
export * from "./em.js"
export * from "./fellegi-sunter.js"
export * from "./tf.js"
