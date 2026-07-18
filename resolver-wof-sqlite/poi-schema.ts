/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Typed schema for poi.db — spatial layer #1 (spec §3.4). One clustered `WITHOUT ROWID` B-tree
 *   keyed `(h3_cell, category_id, neg_rank, rowid_key)` so "everything near this res-9 cell" is a
 *   contiguous key range (the byte-range/httpvfs access pattern, same discipline as the candidate
 *   gazetteer). Rows carry denormalized name/brand/coords; category ids are small ints via the
 *   `poi_category_codes` dictionary (poi-taxonomy category ids are the string side). The DB also
 *   embeds the layer-contract tables from `@mailwoman/core/layers` — the builder writes the
 *   manifest (tier `shipped`, spine `h3` res 9) and per-res-6-cell coverage.
 */

import type { DatabaseSync } from "node:sqlite"

import type { LayerContractDatabase } from "@mailwoman/core/layers"
import { sql, type Kysely } from "kysely"

/** One POI row. Clustered PK: h3_cell → category_id → neg_rank → rowid_key. */
export interface POITable {
	/** 48-bit short H3 cell at res 9 (`latLngToCell` → `shortenH3Cell`). */
	h3_cell: number
	/** Small int from {@link POICategoryCodeTable}; 0 = uncategorized. */
	category_id: number
	/** `-log10(confidence + epsilon)` so ASC = most-confident-first within a cell+category. */
	neg_rank: number
	/** Uniquifier within the clustered key (builder-assigned monotonic int). */
	rowid_key: number
	name: string | null
	/** Lowercased, diacritic-flattened probe key for exact name lookups. */
	name_key: string | null
	brand_wikidata: string | null
	latitude: number
	longitude: number
	/** ISO 3166-1 alpha-2 (from the Overture partition). */
	country: string
	/** Overture existence confidence (already filtered ≥ 0.85 at build). */
	confidence: number
	/** GERS id — nullable METADATA ONLY, never a key (the #470 rule). */
	gers_id: string | null
}

/**
 * Staging mirror — every column nullable except the coords (the loader fills positionally; the materialize SELECT
 * enforces completeness).
 */
export interface POIStageTable {
	h3_cell: number | null
	category_id: number | null
	neg_rank: number | null
	rowid_key: number | null
	name: string | null
	name_key: string | null
	brand_wikidata: string | null
	latitude: number
	longitude: number
	country: string | null
	confidence: number | null
	gers_id: string | null
}

/** `(id → poi-taxonomy category id)` dictionary, e.g. `3 → "cafe"`. */
export interface POICategoryCodeTable {
	id: number
	category: string
}

export interface POIDatabase extends LayerContractDatabase {
	poi: POITable
	poi_stage: POIStageTable
	poi_category_codes: POICategoryCodeTable
}

/** Clustered-key-order column list shared by builder + `INSERT INTO poi SELECT … FROM poi_stage`. */
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
		// `WITHOUT ROWID` has no first-class builder; the raw modifier is the idiomatic fallback.
		.modifyEnd(sql`without rowid`)
		.execute()
}

export const POI_FTS_TABLE = "poi_search"

/** FTS5 stays raw SQL by project rule (Kysely can't express virtual tables). Content-keyed by name_key. */
export function createPOISearchFTS(db: DatabaseSync): void {
	db.exec(
		`CREATE VIRTUAL TABLE ${POI_FTS_TABLE} USING fts5(name, name_key UNINDEXED, h3_cell UNINDEXED, tokenize = 'unicode61')`
	)
}
