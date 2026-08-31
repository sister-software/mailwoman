/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `@mailwoman/registry` — the geocode-first record-matching application.
 *
 *   {@link resolveEntities} runs the whole matcher (block → score → cluster) over normalized
 *   contact/organization {@link SourceRecord}s and returns canonical {@link ResolvedEntity entities};
 *   {@link toGeoJSON} exports them for QGIS. This is the clinic-funding use case mailwoman was built
 *   for, finally standing on a calibrated, label-free matcher.
 */

export * from "#address-key"
export * from "#geojson"
export * from "#ingest"
export * from "#geocode-handler"
export * from "#learned-scorer"
export * from "#map-html"
export * from "#models/dedup-gbt-en-us"
export * from "#reconcile"
export * from "#resolve"
export * from "#types"
