/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `@mailwoman/match` — the geocode-first record matcher: block → score → cluster.
 *
 *   So far: the scoring stage's string {@link jaroWinkler comparators} and the
 *   {@link scorePair Fellegi-Sunter} weight model (agreement levels → `log2(m/u)` weights →
 *   probability → link / review / non-link). Still to land: EM estimation of `m`/`u` +
 *   term-frequency adjustment, geo-first blocking, and centroid-linkage clustering.
 */

export * from "./comparators.js"
export * from "./em.js"
export * from "./fellegi-sunter.js"
