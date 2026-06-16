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

export * from "./address-key.js"
export * from "./geojson.js"
export * from "./ingest.js"
export * from "./learned-scorer.js"
export * from "./map-html.js"
export * from "./models/dedup-gbt-en-us.js"
export * from "./reconcile.js"
export * from "./resolve.js"
export * from "./types.js"
