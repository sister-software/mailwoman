/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `@mailwoman/match` — the geocode-first record matcher: block → score → cluster.
 *
 *   This first cut ships the scoring stage's string {@link jaroWinkler comparators}. The
 *   Fellegi-Sunter agreement-levels + term-frequency adjustment, geo-first blocking, and
 *   centroid-linkage clustering land on top of these.
 */

export * from "./comparators.js"
