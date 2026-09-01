/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Typed schema for `flood.db` — the two-tier polygon layer: the authority's unsimplified rings as the
 *   truth table, an H3 cell table above them as the summary, plus the layer-contract tables from
 *   `@mailwoman/core/layers`.
 *
 *   WHY TWO TIERS. A rooftop answer needs point-in-polygon against the real geometry — hexes alone either
 *   bloat to absurd resolution or lie exactly at zone boundaries, which is where a flood answer matters
 *   most. So the rings are stored once, unsimplified, with a precomputed bbox; the cell table classifies
 *   every cell `whole` or `partial` per zone; a `whole` cell answers in one primary-key probe, and only a
 *   `partial` cell falls through to the ray cast, against just the polygons {@link FloodZoneCellAreaTable}
 *   names for that cell. Size concentrates where it is irreducible: the boundary fringe.
 *
 *   `WITHOUT ROWID` ON THE CELL TABLES AND NEVER ON THE GEOMETRY TABLE. Small fixed-width rows probed by
 *   their exact primary key belong in the B-tree; a row carrying a geometry blob does not — clustering it
 *   into the B-tree makes every index page a geometry page. That is the root `AGENTS.md` rule, and this
 *   layer is the first one where both halves of it appear in the same database.
 *
 *   THE WHOLE-CELL SET IS COMPACTED, SO IT IS MIXED-RESOLUTION. `compactCells` collapses a uniform
 *   interior parent-ward, which is hierarchy-respecting run-length encoding — a zone's interior becomes a
 *   handful of coarse cells and only the fringe stays fine. A row therefore carries its own `resolution`,
 *   and a probe walks `cellToParent` from the index resolution up to the coarsest resolution present.
 *   `layer_coverage` is NOT compacted and stays single-resolution, because
 *   `recoverCoverageResolution` recovers one resolution from the stored cells and throws on a table that
 *   mixes them.
 */

import type { LayerContractDatabase } from "@mailwoman/core/layers"
import { sql, type Kysely } from "kysely"

/**
 * Whether an H3 cell lies wholly inside a zone, or is crossed by its boundary.
 */
export const FloodCellContainment = {
	/**
	 * Every point in the cell is inside the zone. Answered from the index alone, with no geometry read.
	 */
	Whole: "whole",
	/**
	 * The zone boundary crosses the cell. The index has narrowed the candidate polygons; the point test decides.
	 */
	Partial: "partial",
} as const

export type FloodCellContainment = (typeof FloodCellContainment)[keyof typeof FloodCellContainment]

/**
 * One authority polygon, verbatim. A plain rowid table: it holds a geometry blob, which is the one shape `WITHOUT
 * ROWID` hurts.
 */
export interface FloodZoneAreaTable {
	/**
	 * The authority's own feature id — the EA's `OBJECTID`, as text so a source that publishes a non-numeric id needs no
	 * schema change.
	 */
	area_id: string
	/**
	 * The authority's value, verbatim (`FZ2` / `FZ3`). Never re-spelled, never mapped onto a severity scale: two
	 * authorities that both publish "flood zones" are not publishing the same thing.
	 */
	zone_code: string
	/**
	 * A finer classification where the source has one. NULL for the EA product, which publishes none.
	 */
	zone_subtype: string | null
	/**
	 * The EA's `flood_source` — `river`, `sea`, `river and sea`, `undefined`, `unknown`, or absent.
	 */
	zone_source: string | null
	/**
	 * The EA's `origin` — how the extent was arrived at (`modelled`, `recorded`, …).
	 */
	origin: string | null
	/**
	 * The map panel a feature belongs to, where the source publishes one. NULL for the EA product.
	 */
	panel_id: string | null
	/**
	 * The authority's own date for this feature, ISO-8601, where it publishes one.
	 *
	 * NULL for every EA row, and that is a recorded limit rather than an oversight: the published attribute set carries
	 * no per-feature date, while the product itself retains sections of an older model "whilst we make improvements to
	 * the data". So the layer cannot state a per-feature vintage, and `layer_manifest.source_vintage` is the only
	 * granularity available.
	 */
	effective_date: string | null
	min_lat: number
	min_lon: number
	max_lat: number
	max_lon: number
	/**
	 * The authority's ring coordinates, unsimplified — see `rings.ts` for the layout and the point test.
	 */
	rings: Uint8Array
}

/**
 * Per (cell, zone): does the zone cover the whole cell, or only part of it?
 *
 * Keyed on `(h3_cell, zone_code)` rather than on a polygon, because the question a reader asks is about the ZONE. A
 * cell wholly inside any FZ3 polygon answers `FZ3` whichever polygon that was.
 */
export interface FloodZoneCellTable {
	/**
	 * 48-bit short H3 cell. Mixed-resolution: `whole` rows are compacted parent-ward, `partial` rows stay at the index
	 * resolution.
	 */
	h3_cell: number
	/**
	 * The resolution this row's cell was captured at. A short cell does not name its own resolution, and a table that
	 * mixes them cannot be probed without it.
	 */
	resolution: number
	zone_code: string
	/**
	 * One of {@link FloodCellContainment}.
	 */
	containment: string
}

/**
 * For a `partial` cell only: which polygons reach into it.
 *
 * This is the bbox-pruned candidate list the runtime ray cast walks, precomputed. A `whole` cell has no row here and
 * needs none — it is answered by {@link FloodZoneCellTable} alone.
 */
export interface FloodZoneCellAreaTable {
	h3_cell: number
	resolution: number
	area_id: string
}

/**
 * The authority's MAPPED FOOTPRINT — one row per statement, never derived from the hazard polygons.
 *
 * Deriving it from the polygon union is the error this whole layer is built to avoid: Zone 1 IS the mapped area minus
 * the polygons, so a footprint taken from the polygons reports every Zone 1 location as unmapped. What is stored is the
 * authority's own coverage sentence, where it is published, and the boundary artifact used to realize "England" as a
 * cell set — because the sentence names a country and a cell set needs an outline, and which outline that was is part
 * of the claim.
 *
 * The machine-readable footprint is `layer_coverage`: a cell with a row is inside the statement, a cell without is not.
 * This table is that claim's provenance.
 */
export interface FloodMapExtentTable {
	extent_id: string
	/**
	 * What the authority says about this footprint. `mapped` for the EA's England statement; a source with an
	 * availability layer of its own (FEMA's is layer 0) writes its published categories here instead.
	 */
	status: string
	/**
	 * The authority that made the statement.
	 */
	authority: string
	/**
	 * The coverage statement, verbatim.
	 */
	statement: string
	statement_url: string
	/**
	 * Who drew the outline the statement's named area was realized from, and when. Not the flood authority: the EA says
	 * "all of England" and does not publish where England is.
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
	 * How many `layer_coverage` rows this statement produced, and at what resolution — the two numbers a reader needs to
	 * check the footprint without re-deriving it.
	 */
	coverage_cells: number
	coverage_resolution: number
}

/**
 * The authority's declared zone domain, as shipped, so a reader can refuse a code the layer was never built to hold.
 */
export interface FloodZoneVocabularyTable {
	zone_code: string
	label: string
	definition: string
	definition_url: string
}

/**
 * Pass to `new DatabaseClient<FloodDatabase>(...)`.
 */
export interface FloodDatabase extends LayerContractDatabase {
	flood_zone_area: FloodZoneAreaTable
	flood_zone_cell: FloodZoneCellTable
	flood_zone_cell_area: FloodZoneCellAreaTable
	flood_map_extent: FloodMapExtentTable
	flood_zone_vocabulary: FloodZoneVocabularyTable
}

/**
 * The slice of a Kysely handle the DDL touches. Same reasoning as `LayerContractHandle`: Kysely is invariant in its
 * schema parameter, so naming only the members these functions call lets a caller pass its own wider handle.
 */
export type FloodSchemaHandle = Pick<Kysely<FloodDatabase>, "schema">

/**
 * Create `flood_zone_area`. A PLAIN rowid table on purpose — the `rings` blob is exactly the payload `WITHOUT ROWID`
 * penalizes.
 */
export async function createFloodZoneAreaTable(db: FloodSchemaHandle): Promise<void> {
	await db.schema
		.createTable("flood_zone_area")
		.addColumn("area_id", "text", (c) => c.primaryKey())
		.addColumn("zone_code", "text", (c) => c.notNull())
		.addColumn("zone_subtype", "text")
		.addColumn("zone_source", "text")
		.addColumn("origin", "text")
		.addColumn("panel_id", "text")
		.addColumn("effective_date", "text")
		.addColumn("min_lat", "real", (c) => c.notNull())
		.addColumn("min_lon", "real", (c) => c.notNull())
		.addColumn("max_lat", "real", (c) => c.notNull())
		.addColumn("max_lon", "real", (c) => c.notNull())
		.addColumn("rings", "blob", (c) => c.notNull())
		.execute()
}

/**
 * Create `flood_zone_cell` — the summary tier. Small fixed-width rows probed by their exact primary key, which is the
 * `WITHOUT ROWID` shape.
 */
export async function createFloodZoneCellTable(db: FloodSchemaHandle): Promise<void> {
	await db.schema
		.createTable("flood_zone_cell")
		.addColumn("h3_cell", "integer", (c) => c.notNull())
		.addColumn("resolution", "integer", (c) => c.notNull())
		.addColumn("zone_code", "text", (c) => c.notNull())
		.addColumn("containment", "text", (c) => c.notNull())
		.addPrimaryKeyConstraint("flood_zone_cell_pk", ["h3_cell", "zone_code"])
		// `WITHOUT ROWID` has no first-class builder; the raw modifier is the idiomatic fallback.
		.modifyEnd(sql`without rowid`)
		.execute()
}

/**
 * Create `flood_zone_cell_area` — the `partial`-cell candidate lists, same clustered shape.
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
 * Create `flood_map_extent`.
 */
export async function createFloodMapExtentTable(db: FloodSchemaHandle): Promise<void> {
	await db.schema
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
		.addColumn("min_lat", "real", (c) => c.notNull())
		.addColumn("min_lon", "real", (c) => c.notNull())
		.addColumn("max_lat", "real", (c) => c.notNull())
		.addColumn("max_lon", "real", (c) => c.notNull())
		.addColumn("coverage_cells", "integer", (c) => c.notNull())
		.addColumn("coverage_resolution", "integer", (c) => c.notNull())
		.execute()
}

/**
 * Create `flood_zone_vocabulary`.
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
 * Every domain table this layer owns, in dependency order.
 */
export async function createFloodTables(db: FloodSchemaHandle): Promise<void> {
	await createFloodZoneAreaTable(db)
	await createFloodZoneCellTable(db)
	await createFloodZoneCellAreaTable(db)
	await createFloodMapExtentTable(db)
	await createFloodZoneVocabularyTable(db)
}
