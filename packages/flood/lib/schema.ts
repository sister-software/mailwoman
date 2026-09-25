/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Defines the `flood.db` schema.
 *
 *   The database stores each authority polygon once, unsimplified, with its bounding box. An H3 cell table
 *   marks each cell as `whole` or `partial` for each zone. A `whole` cell answers a lookup from its primary
 *   key alone. A `partial` cell needs a point-in-polygon test against the polygons that
 *   {@link FloodZoneCellAreaTable} lists for it.
 *
 *   The cell tables use `without rowid` because their small rows are read by exact primary key. The polygon
 *   table keeps its rowid because its geometry blobs would fill the B-tree pages.
 *
 *   The `whole` cells are compacted to coarser parents, so each row stores its own `resolution`. A lookup
 *   walks `cellToParent` up from the index resolution. `layer_coverage` stays at one resolution because
 *   `recoverCoverageResolution` throws on mixed resolutions.
 */

import type { layerschemadatabase } from "@mailwoman/core/layers"
import { addBoundingBoxColumns, addCellIndexColumns, addRingGeometryColumns } from "@mailwoman/sqlite/schema-columns"
import { sql, type Kysely } from "kysely"

/**
 * Whether an H3 cell lies wholly inside a zone or straddles its boundary.
 */
export const FloodCellContainment = {
	/**
	 * The whole cell lies inside the zone, so a lookup reads no geometry.
	 */
	Whole: "whole",
	/**
	 * The zone boundary crosses the cell, so a lookup runs the point test.
	 */
	Partial: "partial",
} as const

/**
 * Union of the {@link FloodCellContainment} values.
 */
export type FloodCellContainment = (typeof FloodCellContainment)[keyof typeof FloodCellContainment]

/**
 * One authority polygon, stored unchanged.
 */
export interface FloodZoneAreaTable {
	/**
	 * The authority's feature ID, such as the EA's `objectid`.
	 *
	 * The column is text so a source with non-numeric IDs fits without a schema change.
	 */
	area_id: string
	/**
	 * The authority's zone code as published, such as `FZ2` or `FZ3`.
	 *
	 * Codes are never mapped onto a shared severity scale because each authority
	 * defines its zones differently.
	 */
	zone_code: string
	/**
	 * A finer classification, when the source has one.
	 * It is `NULL` for EA data.
	 */
	zone_subtype: string | null
	/**
	 * The EA's `flood_source`, such as `river`, `sea` or `river and sea`.
	 */
	zone_source: string | null
	/**
	 * The EA's `origin`, which says how the extent was derived, such as `modelled` or `recorded`.
	 */
	origin: string | null
	/**
	 * The map panel that holds the feature, when the source has panels.
	 * It is `NULL` for EA data.
	 */
	panel_id: string | null
	/**
	 * The authority's ISO-8601 date for this feature, when it publishes one.
	 *
	 * EA data has no per-feature date, so `layer_manifest.source_vintage` is the finest date available.
	 */
	effective_date: string | null
	min_lat: number
	min_lon: number
	max_lat: number
	max_lon: number
	/**
	 * Unsimplified ring coordinates.
	 * `rings.ts` defines the encoding and the point test.
	 */
	rings: Uint8Array
}

/**
 * Whether a zone covers all or part of an H3 cell.
 *
 * The key is `(h3_cell, zone_code)` because readers ask about zones.
 * The polygon that covered a cell is irrelevant to a `whole` answer.
 */
export interface FloodZoneCellTable {
	/**
	 * 48-bit short H3 cell.
	 *
	 * `whole` rows are compacted to coarser parents.
	 * `partial` rows stay at the index resolution.
	 */
	h3_cell: number
	/**
	 * The cell's resolution.
	 * A short cell does not encode its own resolution.
	 */
	resolution: number
	zone_code: string
	/**
	 * One of {@link FloodCellContainment}.
	 */
	containment: string
}

/**
 * The polygons that intersect a `partial` cell.
 *
 * This list is the precomputed candidate set for the point test.
 * `whole` cells have no rows here.
 */
export interface FloodZoneCellAreaTable {
	h3_cell: number
	resolution: number
	area_id: string
}

/**
 * The provenance of the authority's mapped area, one row per coverage statement.
 *
 * The mapped area comes from the authority's statement and never from the union of the polygons.
 * Zone 1 is the mapped area outside the polygons, so a polygon-derived footprint
 * would report Zone 1 as unmapped.
 *
 * `layer_coverage` holds the resulting cells.
 * This table records the statement and the boundary used to turn a named area such as "England" into cells.
 */
export interface FloodMapExtentTable {
	extent_id: string
	/**
	 * The authority's status for this area, such as `mapped` for the EA's England statement.
	 *
	 * A source with its own availability layer, such as FEMA, writes its published categories here.
	 */
	status: string
	/**
	 * The authority that made the statement.
	 */
	authority: string
	/**
	 * The coverage statement, quoted exactly.
	 */
	statement: string
	statement_url: string
	/**
	 * The publisher of the boundary used to turn the named area into cells.
	 *
	 * The EA covers "all of England" but publishes no outline of England,
	 * so the boundary comes from elsewhere.
	 */
	boundary_source: string
	boundary_source_url: string
	boundary_vintage: string
	boundary_license: string
	effective_date: string | null
	min_lat: number
	min_lon: number
	max_lat: number
	max_lon: number
	/**
	 * The count and resolution of the `layer_coverage` rows this statement produced.
	 */
	coverage_cells: number
	coverage_resolution: number
}

/**
 * The zone codes the authority defines.
 * A reader can reject any code missing from this table.
 */
export interface FloodZoneVocabularyTable {
	zone_code: string
	label: string
	definition: string
	definition_url: string
}

/**
 * Kysely schema for `flood.db`.
 */
export interface FloodDatabase extends layerschemadatabase {
	flood_zone_area: FloodZoneAreaTable
	flood_zone_cell: FloodZoneCellTable
	flood_zone_cell_area: FloodZoneCellAreaTable
	flood_map_extent: FloodMapExtentTable
	flood_zone_vocabulary: FloodZoneVocabularyTable
}

/**
 * The part of a Kysely handle that the table functions use.
 *
 * Kysely is invariant in its schema parameter.
 * Picking only `schema` lets a caller pass a handle with a wider schema.
 */
export type FloodSchemaHandle = Pick<Kysely<FloodDatabase>, "schema">

/**
 * Creates `flood_zone_area`.
 *
 * The table keeps its rowid because `without rowid` would store the `rings` blobs in the B-tree.
 */
export async function createFloodZoneAreaTable(db: FloodSchemaHandle): Promise<void> {
	const table = db.schema
		.createTable("flood_zone_area")
		.addColumn("area_id", "text", (c) => c.primaryKey())
		.addColumn("zone_code", "text", (c) => c.notNull())
		.addColumn("zone_subtype", "text")
		.addColumn("zone_source", "text")
		.addColumn("origin", "text")
		.addColumn("panel_id", "text")
		.addColumn("effective_date", "text")

	await addRingGeometryColumns(table).execute()
}

/**
 * Creates `flood_zone_cell` as a `without rowid` table.
 */
export async function createFloodZoneCellTable(db: FloodSchemaHandle): Promise<void> {
	const table = db.schema.createTable("flood_zone_cell")

	await addCellIndexColumns(table, "zone_code")
		.addPrimaryKeyConstraint("flood_zone_cell_pk", ["h3_cell", "zone_code"])
		// Kysely has no builder method for `without rowid`.
		.modifyEnd(sql`without rowid`)
		.execute()
}

/**
 * Creates `flood_zone_cell_area` as a `without rowid` table.
 */
export async function createFloodZoneCellAreaTable(db: FloodSchemaHandle): Promise<void> {
	await db.schema
		.createTable("flood_zone_cell_area")
		.addColumn("h3_cell", "integer", (c) => c.notNull())
		.addColumn("resolution", "integer", (c) => c.notNull())
		.addColumn("area_id", "text", (c) => c.notNull())
		.addPrimaryKeyConstraint("flood_zone_cell_area_pk", ["h3_cell", "area_id"])
		.modifyEnd(sql`without rowid`)
		.execute()
}

/**
 * Creates `flood_map_extent`.
 */
export async function createFloodMapExtentTable(db: FloodSchemaHandle): Promise<void> {
	const table = db.schema
		.createTable("flood_map_extent")
		.addColumn("extent_id", "text", (c) => c.primaryKey())
		.addColumn("status", "text", (c) => c.notNull())
		.addColumn("authority", "text", (c) => c.notNull())
		.addColumn("statement", "text", (c) => c.notNull())
		.addColumn("statement_url", "text", (c) => c.notNull())
		.addColumn("boundary_source", "text", (c) => c.notNull())
		.addColumn("boundary_source_url", "text", (c) => c.notNull())
		.addColumn("boundary_vintage", "text", (c) => c.notNull())
		.addColumn("boundary_license", "text", (c) => c.notNull())
		.addColumn("effective_date", "text")

	await addBoundingBoxColumns(table)
		.addColumn("coverage_cells", "integer", (c) => c.notNull())
		.addColumn("coverage_resolution", "integer", (c) => c.notNull())
		.execute()
}

/**
 * Creates `flood_zone_vocabulary`.
 */
export async function createFloodZoneVocabularyTable(db: FloodSchemaHandle): Promise<void> {
	await db.schema
		.createTable("flood_zone_vocabulary")
		.addColumn("zone_code", "text", (c) => c.primaryKey())
		.addColumn("label", "text", (c) => c.notNull())
		.addColumn("definition", "text", (c) => c.notNull())
		.addColumn("definition_url", "text", (c) => c.notNull())
		.execute()
}

/**
 * Creates every flood-specific table.
 */
export async function createFloodTables(db: FloodSchemaHandle): Promise<void> {
	await createFloodZoneAreaTable(db)
	await createFloodZoneCellTable(db)
	await createFloodZoneCellAreaTable(db)
	await createFloodMapExtentTable(db)
	await createFloodZoneVocabularyTable(db)
}
