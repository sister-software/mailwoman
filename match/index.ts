/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `@mailwoman/match` — the geocode-first record matcher: block → score → cluster.
 *
 *   The full three-stage pipeline:
 *
 *   1. {@link block Block} — geo-first candidate generation (a spatial-cell union of cheap, high-recall
 *        keys), so two records at the same place meet regardless of address spelling.
 *   2. **Score** — string {@link jaroWinkler comparators} → the {@link scorePair Fellegi-Sunter} weight
 *        model (agreement levels → `log2(m/u)` weights → probability → link / review / non-link),
 *        with `m`/`u` learned label-free by {@link estimateParameters EM} and rare-value agreement
 *        up-weighted by {@link withTermFrequency term frequency}.
 *   3. {@link cluster Cluster} — resolve the non-transitive pairwise link graph into canonical entities.
 */

export * from "./blocking.js"
export * from "./clustering.js"
export * from "./comparators.js"
export * from "./distance.js"
export * from "./em.js"
export * from "./fellegi-sunter.js"
export * from "./tf.js"
