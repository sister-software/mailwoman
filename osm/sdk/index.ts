/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `@mailwoman/osm` SDK — the OpenStreetMap rooftop ingestion surface. PERMISSIVE CODE ONLY: this
 *   workspace contains no OSM data bytes. It reads a Geofabrik `.osm.pbf` extract (the ODbL source)
 *   and writes a per-country rooftop address-point shard on the SHARED situs schema
 *   (`@mailwoman/resolver-wof-sqlite/address-point-schema`). The ODbL obligation rides on the BUILT
 *   shard (a Derived Database), never on this code. See `osm/README.md` for the licensing boundary.
 */

export * from "./fetch.ts"
export * from "./extract.ts"
export * from "./street-locale.ts"
export * from "./shard-provider.ts"
export * from "./street-recovery.ts"
