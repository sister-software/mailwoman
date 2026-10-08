/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The typed-evidence interface. Its one runtime dependency is `zod`, for the wire schemas each type is
 *   inferred from. `@mailwoman/bdc`, `@mailwoman/resolver`, `@mailwoman/filer` and `@mailwoman/match` all consume
 *   this, and two of them are leaves. A dependency on `@mailwoman/core` would add core's shipped data to every
 *   consumer. That data size also explains why `nuts-lookup` and `timezone-lookup` re-implement a ray cast rather
 *   than depend on `@mailwoman/spatial`. Do not add another dependency here.
 */

export * from "#coverage"
export * from "#derivation"
export * from "#evidence"
export * from "#status"
