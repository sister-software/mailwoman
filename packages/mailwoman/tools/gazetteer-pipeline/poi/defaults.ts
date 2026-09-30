/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The POI build's tunable defaults, kept import-free so command specifications can interpolate them
 *   without loading DuckDB, h3-js, or the resolver schema layer.
 */

/**
 * Pinned Overture release for the places-theme ingest, kept independent of the
 * `.tsx` command's pin because `gazetteer-pipeline/*.ts` must stay importable under
 * plain `node` type-stripping without a JSX transform.
 */
export const DEFAULT_RELEASE = "2026-07-22.0"

/**
 * Default for `--min-rows`.
 *
 * This value keeps the table to real chains rather than one-off name collisions.
 */
export const DEFAULT_MIN_ROWS = 25

/**
 * `--dominance` default, the fraction of a QID's total rows its modal name must cover to qualify.
 *
 * Below it the QID is dropped as systematically mistagged rather than demoted
 * like a sub-noise-floor variant.
 */
export const DEFAULT_DOMINANCE = 0.5
