/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Kysely table types for the subset of the Who's On First SQLite schema we touch in Phase 4.2.
 *
 *   The full upstream distribution at data.geocode.earth/wof/dist/sqlite/ ships ~7 tables; this file
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
 * without a second SELECT. The actual FTS rebuild happens in `fts.ts::buildPlaceSearchFts`.
 */
export interface PlaceSearchTable {
	rowid: number
	wof_id: number
	name: string
	alt_names: string | null
}

/**
 * `spr` — the Who's On First "Standard Places Response": a denormalized lightweight summary of one
 * row per place. The resolver's main lookup table.
 *
 * Lifecycle flags carry TWO conventions, both meaning "currently valid": `is_current = -1` (modern
 * Who's On First) and `is_current = 1` (legacy Mapzen-era). Only `is_current = 0` means "not
 * current". Filters in `lookup.ts` and `fts.ts` use `is_current != 0 AND is_deprecated = 0` — see
 * #91 for the diagnostic that uncovered the mixed-convention reality.
 *
 * Lat/lon live directly on this row — no GeoJSON extraction needed for centroid resolution. `min_*`
 * / `max_*` form a bounding box if callers want one (Phase 4.3 candidate).
 */
export interface SprTable {
	id: number
	parent_id: number | null
	name: string | null
	placetype: string | null
	country: string | null
	latitude: number
	longitude: number
	min_latitude: number
	min_longitude: number
	max_latitude: number
	max_longitude: number
	is_current: number
	is_deprecated: number
	is_ceased: number
	is_superseded: number
	is_superseding: number
	superseded_by: string | null
	supersedes: string | null
	lastmodified: number
}

/**
 * Alternate names per place, keyed by language tag subfields (BCP-47 components). Joins back to
 * `spr.id` via `id` (NOT `place_id` — the real WOF schema uses the same column name as the spr
 * primary key; this is a normal join across two tables with the same FK column name).
 *
 * No `kind` column in real WOF — the FTS build just concatenates ALL names per id.
 */
export interface NamesTable {
	id: number
	placetype: string | null
	country: string | null
	language: string | null // ISO-639 alpha-3
	extlang: string | null
	script: string | null
	region: string | null
	variant: string | null
	extension: string | null
	privateuse: string | null
	name: string
	lastmodified: number
}

/**
 * Per-place GeoJSON blob. Centroid lat/lon are already exposed via `spr.{latitude,longitude}` so
 * the resolver doesn't need to parse this; we keep the table modeled in case Phase 4.3 wants the
 * full geometry for bbox / polygon work.
 */
export interface GeojsonTable {
	id: number
	body: string
	source: string | null
	alt_label: string | null
	is_alt: number
	lastmodified: number
}

/**
 * Adjacency table for ancestor relationships. One row per (place, ancestor) pair, including
 * transitive ancestors. Used to implement `FindPlaceQuery.parentId` (descendant lookup).
 */
export interface AncestorsTable {
	id: number
	ancestor_id: number
	ancestor_placetype: string | null
	lastmodified: number
}

/**
 * The full schema we hand to `Kysely<WofDatabase>`. Tables not listed here will fail type-checked
 * queries — by design.
 */
export interface WofDatabase {
	place_search: PlaceSearchTable
	spr: SprTable
	names: NamesTable
	geojson: GeojsonTable
	ancestors: AncestorsTable
}
