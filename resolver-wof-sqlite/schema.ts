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
 * `content` is unindexed — it's there so we can roundtrip the original name back to the caller without a second SELECT.
 * The actual FTS rebuild happens in `fts.ts::buildPlaceSearchFTS`.
 */
export interface PlaceSearchTable {
	rowid: number
	wof_id: number
	name: string
	alt_names: string | null
}

/**
 * `spr` — the Who's On First "Standard Places Response": a denormalized lightweight summary of one row per place. The
 * resolver's main lookup table.
 *
 * Lifecycle flags carry TWO conventions, both meaning "currently valid": `is_current = -1` (modern Who's On First) and
 * `is_current = 1` (legacy Mapzen-era). Only `is_current = 0` means "not current". Filters in `lookup.ts` and `fts.ts`
 * use `is_current != 0 AND is_deprecated = 0` — see #91 for the diagnostic that uncovered the mixed-convention
 * reality.
 *
 * Lat/lon live directly on this row — no GeoJSON extraction needed for centroid resolution. `min_*` / `max_*` form a
 * bounding box if callers want one (Phase 4.3 candidate).
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
 * Alternate names per place, keyed by language tag subfields (BCP-47 components). Joins back to `spr.id` via `id` (NOT
 * `place_id` — the real WOF schema uses the same column name as the spr primary key; this is a normal join across two
 * tables with the same FK column name).
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
 * Per-place GeoJSON blob. Centroid lat/lon are already exposed via `spr.{latitude,longitude}` so the resolver doesn't
 * need to parse this; we keep the table modeled in case Phase 4.3 wants the full geometry for bbox / polygon work.
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
 * Adjacency table for ancestor relationships. One row per (place, ancestor) pair, including transitive ancestors. Used
 * to implement `FindPlaceQuery.parentId` (descendant lookup).
 */
export interface AncestorsTable {
	id: number
	ancestor_id: number
	ancestor_placetype: string | null
	lastmodified: number
}

/**
 * `place_population` — `id → wof:population`, split off `spr` so a population-rank join is a single indexed probe.
 * Written by the build/augment ingest + the GeoNames backfill; read by the candidate build's `neg_rank`. WOF carries
 * population for ~15% of localities; absent = unknown, not zero.
 */
export interface PlacePopulationTable {
	id: number
	population: number
}

/**
 * `place_abbr` — `id → abbreviation` (e.g. `IL → Illinois`), derived from `names` rows whose `language = 'abbr'`. Lets
 * the resolver accept a 2-letter region abbreviation as an exact match.
 */
export interface PlaceAbbrTable {
	id: number
	abbr: string
}

/**
 * `concordances` — external-id cross-references per place (`id → (other_source, other_id)`), e.g. a GeoNames or
 * Overture GERS id. Metadata only; not part of the resolve path.
 */
export interface ConcordancesTable {
	id: number
	other_id: string
	other_source: string
	lastmodified: number
}

/**
 * `coincident_roles` (#402) — the dual-role relation: a place that is BOTH an admin region AND a locality (Berlin the
 * city-state). One row per (admin, locality) pair the resolver can complete a hierarchy with. Surfaced by
 * {@link MailwomanLookupLike.coincidentRolesFor}.
 */
export interface CoincidentRolesTable {
	admin_id: number
	locality_id: number
	relationship_type: string
	admin_placetype: string
	distance_km: number
	locality_population: number
}

/**
 * The full schema we hand to `Kysely<WOFDatabase>` / `new DatabaseClient<WOFDatabase>(...)`. Tables not listed here
 * will fail type-checked queries — by design. The reader ({@link WOFSqlitePlaceLookup}) already consumes this; the
 * build/augment WRITERS adopt it so a column rename is a compile error on both sides (the drift that bit the corpus
 * TIGER adapter).
 */
export interface WOFDatabase {
	place_search: PlaceSearchTable
	spr: SprTable
	names: NamesTable
	geojson: GeojsonTable
	ancestors: AncestorsTable
	place_population: PlacePopulationTable
	place_abbr: PlaceAbbrTable
	concordances: ConcordancesTable
	coincident_roles: CoincidentRolesTable
}
