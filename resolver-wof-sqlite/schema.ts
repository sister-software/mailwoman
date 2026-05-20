/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Kysely table types for the subset of the Who's On First SQLite schema we touch in Phase 4.2.
 *
 *   The full upstream distribution at data.geocode.earth/wof/dist/sqlite/ ships ~20 tables; this file
 *   models only the ones we read. Pretending to model the others would be misleading — we haven't
 *   verified their shapes and they're not part of the resolver's contract.
 *
 *   Authoritative schema docs:
 *
 *   - Whosonfirst SQLite README: https://github.com/whosonfirst/go-whosonfirst-sqlite
 *   - Per-table sources under https://github.com/whosonfirst/go-whosonfirst-sqlite-features
 */

/**
 * The FTS5 virtual table built by this package on first open (NOT shipped by upstream WOF).
 *
 * `content` is unindexed — it's there so we can roundtrip the original name back to the caller
 * without a second SELECT. The actual FTS rebuild happens in `lookup.ts::ensureFts`.
 */
export interface PlaceSearchTable {
	rowid: number
	wof_id: number
	name: string
	alt_names: string | null
}

/**
 * One row per WOF place.
 *
 * Real distribution has many more columns (`is_current`, `is_deprecated`, `superseded_by`, etc.).
 * We surface only what the resolver actually queries.
 */
export interface PlacesTable {
	id: number
	parent_id: number | null
	name: string
	placetype: string
	country: string | null
}

/**
 * Alternate names per place, keyed by language + kind. Joins back to `places.id` via `place_id`.
 */
export interface NamesTable {
	rowid: number
	place_id: number
	language: string // ISO-639 alpha-3
	kind: string // 'preferred' / 'colloquial' / 'variant' / etc.
	name: string
}

/**
 * Per-place GeoJSON blob. Centroid lives at `properties."geom:latitude"` /
 * `properties."geom:longitude"`. The resolver uses SQLite's json_extract() rather than parsing the
 * blob in TS.
 */
export interface GeojsonTable {
	id: number
	body: string
}

/**
 * Adjacency table for ancestor relationships. One row per (place, ancestor) pair, including
 * transitive ancestors. Used to implement `FindPlaceQuery.parentId` (descendant lookup).
 */
export interface AncestorsTable {
	id: number
	ancestor_id: number
	ancestor_placetype: string
}

/**
 * The full schema we hand to `Kysely<WofDatabase>`. Tables not listed here will fail type-checked
 * queries — by design.
 */
export interface WofDatabase {
	place_search: PlaceSearchTable
	places: PlacesTable
	names: NamesTable
	geojson: GeojsonTable
	ancestors: AncestorsTable
}
