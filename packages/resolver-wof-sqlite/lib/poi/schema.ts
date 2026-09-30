/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Typed schema for poi.db, the first spatial layer (spec §3.4). One clustered `without rowid`
 *   B-tree uses `(h3_cell, category_id, neg_rank, rowid_key)` as its key. All rows near a res-9 cell
 *   occupy a contiguous key range. This matches byte-range and httpvfs access and follows the
 *   candidate gazetteer's layout. Rows include denormalized name, brand and coordinates.
 *   The `poi_category_codes` dictionary stores category ids as small integers. POI-taxonomy category
 *   ids remain strings. The database embeds the layer-interface tables from `@mailwoman/core/layers`.
 *   The builder writes a manifest with tier `shipped` and spine `h3` res 9. It also writes per-res-6-cell coverage.
 */

import type { layerschemadatabase } from "@mailwoman/core/layers"
import type { DatabaseClient } from "@mailwoman/sqlite/client"
import { sql, type Kysely } from "kysely"

import type { NameKey } from "#street/normalize"

/**
 * One POI row.
 *
 * Clustered PK: h3_cell → category_id → neg_rank → rowid_key.
 */
export interface POITable {
	/**
	 * 48-bit short H3 cell at res 9 (`latLngToCell` → `shortenH3Cell`).
	 */
	h3_cell: number
	/**
	 * Small int from {@link POICategoryCodeTable}; 0 = uncategorized.
	 */
	category_id: number
	/**
	 * `-log10(confidence + epsilon)` so ASC = most-confident-first within a cell+category.
	 */
	neg_rank: number
	/**
	 * Uniquifier within the clustered key (builder-assigned monotonic int).
	 */
	rowid_key: number
	name: string | null
	/**
	 * Probe key for exact name lookups, minted by {@link normalizeLocalityForKey} at build and at query.
	 *
	 * Branded because a `toLowerCase()` approximation of the fold is still a `string`.
	 * That approximation binds to the parameter and returns fewer rows.
	 *
	 * The shortfall looks like a data coverage gap instead of a probe defect.
	 */
	name_key: NameKey | null
	brand_wikidata: string | null
	latitude: number
	longitude: number
	/**
	 * ISO 3166-1 alpha-2 (from the Overture partition).
	 */
	country: string
	/**
	 * Overture existence confidence (already filtered ≥ 0.85 at build).
	 */
	confidence: number
	/**
	 * Gers id.
	 * Nullable metadata, never a key.
	 */
	gers_id: string | null
}

/**
 * The staging mirror.
 * Every column is nullable except the coords.
 *
 * The loader fills this table positionally.
 * The materialize select enforces completeness.
 */
export interface POIStageTable {
	h3_cell: number | null
	category_id: number | null
	neg_rank: number | null
	rowid_key: number | null
	name: string | null
	name_key: NameKey | null
	brand_wikidata: string | null
	latitude: number
	longitude: number
	country: string | null
	confidence: number | null
	gers_id: string | null
}

/**
 * `(id → poi-taxonomy category id)` dictionary, e.g. `3 → "cafe"`.
 */
export interface POICategoryCodeTable {
	id: number
	category: string
}

export interface POIDatabase extends layerschemadatabase {
	poi: POITable
	poi_stage: POIStageTable
	poi_category_codes: POICategoryCodeTable
}

/**
 * Clustered-key-order column list shared by builder + `insert into poi select … from poi_stage`.
 */
export const POI_COLUMNS = [
	"h3_cell",
	"category_id",
	"neg_rank",
	"rowid_key",
	"name",
	"name_key",
	"brand_wikidata",
	"latitude",
	"longitude",
	"country",
	"confidence",
	"gers_id",
] as const

export async function createPOIStagingTables(db: Kysely<POIDatabase>): Promise<void> {
	await db.schema
		.createTable("poi_category_codes")
		.addColumn("id", "integer", (c) => c.primaryKey())
		.addColumn("category", "text", (c) => c.unique())
		.execute()

	await db.schema
		.createTable("poi_stage")
		.addColumn("h3_cell", "integer")
		.addColumn("category_id", "integer")
		.addColumn("neg_rank", "real")
		.addColumn("rowid_key", "integer")
		.addColumn("name", "text")
		.addColumn("name_key", "text")
		.addColumn("brand_wikidata", "text")
		.addColumn("latitude", "real")
		.addColumn("longitude", "real")
		.addColumn("country", "text")
		.addColumn("confidence", "real")
		.addColumn("gers_id", "text")
		.execute()
}

export async function createPOITable(db: Kysely<POIDatabase>): Promise<void> {
	await db.schema
		.createTable("poi")
		.addColumn("h3_cell", "integer", (c) => c.notNull())
		.addColumn("category_id", "integer", (c) => c.notNull())
		.addColumn("neg_rank", "real", (c) => c.notNull())
		.addColumn("rowid_key", "integer", (c) => c.notNull())
		.addColumn("name", "text")
		.addColumn("name_key", "text")
		.addColumn("brand_wikidata", "text")
		.addColumn("latitude", "real", (c) => c.notNull())
		.addColumn("longitude", "real", (c) => c.notNull())
		.addColumn("country", "text", (c) => c.notNull())
		.addColumn("confidence", "real", (c) => c.notNull())
		.addColumn("gers_id", "text")
		.addPrimaryKeyConstraint("poi_pk", ["h3_cell", "category_id", "neg_rank", "rowid_key"])
		// `without rowid` has no first-class builder. The raw modifier is the idiomatic fallback.
		.modifyEnd(sql`without rowid`)
		.execute()
}

/**
 * Secondary index for the FTS-hydration path.
 *
 * Builders call this after the bulk materialize (index-after-load).
 */
export async function createPOINameKeyIndex(db: Kysely<POIDatabase>): Promise<void> {
	await db.schema.createIndex("poi_name_key").on("poi").column("name_key").execute()
}

/**
 * Secondary index for the brand path, a brand-wide fetch by `brand_wikidata` with no `h3_cell` prefix.
 *
 * Brand rows are globally sparse, so the k-ring walk can never reach them and the reader
 * instead fetches all of a brand's rows and distance-sorts.
 * Without this index that fetch is a full-table scan, while with it the fetch is a range-scan.
 *
 * The partial index (`where brand_wikidata is not NULL`) keeps the mostly unbranded rows out of the B-tree.
 *
 * Builders call this after the bulk materialize (index-after-load),
 * same phase as {@link createPOINameKeyIndex}.
 */
export async function createPOIBrandIndex(db: Kysely<POIDatabase>): Promise<void> {
	await db.schema
		.createIndex("poi_brand_wikidata")
		.on("poi")
		.column("brand_wikidata")
		.where("brand_wikidata", "is not", null)
		.execute()
}

/**
 * FTS5 virtual table backing POI name search in poi.db.
 */
export const POI_FTS_TABLE = "poi_search"

/**
 * FTS5 stays raw SQL by project rule (Kysely can't express virtual tables).
 *
 * Content-keyed by name_key.
 */
export function createPOISearchFTS<DB>(db: DatabaseClient<DB>): void {
	db.exec(
		`CREATE VIRTUAL TABLE ${POI_FTS_TABLE} USING fts5(name, name_key UNINDEXED, h3_cell UNINDEXED, tokenize = 'unicode61')`
	)
}
