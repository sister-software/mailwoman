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

export * from "./address-key.ts"
export * from "./geojson.ts"
export * from "./ingest.ts"
export * from "./geocode-handler.ts"
export * from "./learned-scorer.ts"
export * from "./map-html.ts"
export * from "./models/dedup-gbt-en-us.ts"
export * from "./reconcile.ts"
export * from "./resolve.ts"
export * from "./types.ts"
