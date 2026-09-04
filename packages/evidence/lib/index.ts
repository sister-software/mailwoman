/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The typed-evidence contract. Zero runtime dependencies BY DESIGN: `@mailwoman/bdc`, `@mailwoman/resolver`,
 *   `@mailwoman/filer` and `@mailwoman/match` all consume this, and two of them are leaves. Routing it through
 *   `@mailwoman/core` would drag core's shipped data behind every one of them — the same cost that makes
 *   `nuts-lookup` and `timezone-lookup` re-implement a ray cast rather than depend on `@mailwoman/spatial`. Do not add
 *   a dependency here.
 */

export * from "#coverage"
export * from "#evidence"
export * from "#status"
