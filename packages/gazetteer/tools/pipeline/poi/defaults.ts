/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The POI build's tunable defaults, kept import-free so command specifications can interpolate them
 *   without loading DuckDB, h3-js, or the resolver schema layer.
 */

/**
 * Pinned Overture release for every Overture theme the gazetteer reads: places, divisions and addresses.
 *
 * One artifact must use a single vintage, and Overture deletes old releases from
 * its bucket about a month after publishing a newer one.
 * A pruned pin fails the admin build at its preflight.
 */
export const DEFAULT_RELEASE = "2026-09-23.1"

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
