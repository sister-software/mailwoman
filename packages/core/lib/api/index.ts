/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Core API utilities.
 */

export * from "#api/APIClient"
export * from "#api/arcgis"
export * from "#api/ckan"
export * from "#api/clock"
export * from "#api/defaults"
export * from "#api/headless"
export * from "#api/host"
export * from "#api/ogc"
export * from "#api/pacer"
export * from "#api/responses"
export * from "#api/retry"

// NOT `./disk-storage.ts` — it imports `node:fs/promises`, and this barrel reaches a browser bundle
// (docs' DashboardMap → @mailwoman/cartographer → tiles/api.ts → @mailwoman/core/api). Import it from
// its own `@mailwoman/core/api/disk-storage` subpath.
