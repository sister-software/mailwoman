/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { layerschemadatabase } from "@mailwoman/core/layers"
import { addBoundingBoxColumns, addCellIndexColumns, addRingsColumn } from "@mailwoman/sqlite/schema-columns"
import { sql, type Kysely } from "kysely"

/**
 * Whether an H3 cell lies wholly inside a zoning polygon, or is crossed by its boundary.
 */
export const ZoningCellContainment = {
	/**
	 * Every point in the cell is inside the zone, answered from the index alone with no geometry read.
	 */
	Whole: "whole",
	/**
	 * The zone boundary crosses the cell, so the point test decides after the index narrows the candidates.
	 */
	Partial: "partial",
} as const

export type ZoningCellContainment = (typeof ZoningCellContainment)[keyof typeof ZoningCellContainment]

/**
 * One authority zoning polygon, verbatim.
 *
 * A plain rowid table: it holds a geometry blob, which is the one shape `without rowid` hurts.
 */
export interface ZoningAreaTable {
	/**
	 * The authority's own feature id, as published and unique across the product, so it needs no scoping prefix.
	 */
	area_id: string
	/**
	 * The authority that adopted the plan.
	 *
	 * FK to `zoning_jurisdiction`.
	 */
	jurisdiction_id: string
	/**
	 * The plan this zone belongs to, keyed to `zoning_plan`: a zone without its plan is not a claim.
	 */
	plan_id: string
	/**
	 * `ZONE_ORIG` — the authority'S own zone code, verbatim, in its own spelling
	 * including case and trailing space.
	 *
	 * Compared case-insensitively where it must be compared.
	 * Never stored normalized.
	 */
	local_code: string
	/**
	 * `ZONE_DESC` — the authority's own description of that code.
	 */
	local_description: string | null
	/**
	 * `ZONE_LINK` — the authority's own link to the plan text.
	 *
	 * A live host, unlike the crosswalk's.
	 */
	local_code_url: string | null
	/**
	 * `ZONE_GZT` — the Department's national generic type, beside the local code and never instead of it.
	 *
	 * NULL where a publisher ships no crosswalk.
	 */
	crosswalk_code: string | null
	/**
	 * Which crosswalk `crosswalk_code` belongs to.
	 *
	 * NULL with the above.
	 */
	crosswalk_scheme: string | null
	/**
	 * `GZT_DESC` — the Department's own description of the generic type, as published on the row.
	 */
	crosswalk_description: string | null
	/**
	 * `SZO` — a coarser code from the same authority, carried as published rather than derived.
	 */
	crosswalk_rollup: string | null
	/**
	 * One of {@link ProvenanceGrade}.
	 *
	 * `not NULL` with a `check` that refuses a blank.
	 */
	provenance_grade: string
	min_lat: number
	min_lon: number
	max_lat: number
	max_lon: number
	/**
	 * How many rings the source published for this feature, with `signed_area_m2`,
	 * the ingest's own receipt that the orientation was read rather than assumed.
	 */
	ring_count: number
	/**
	 * The signed ring sum, in square metres, positive under this service's clockwise-exterior convention.
	 */
	signed_area_m2: number
	/**
	 * The authority's ring coordinates, unsimplified, with hole roles resolved.
	 *
	 * See `ring-roles.ts` for the resolution and `rings.ts` for the layout and the point test.
	 */
	rings: Uint8Array
}

/**
 * The plan a zone lives inside.
 */
export interface ZoningPlanTable {
	plan_id: string
	jurisdiction_id: string
	/**
	 * `PLAN_NAME`, verbatim — "Fingal Development Plan 2023-2029".
	 */
	plan_name: string
	/**
	 * `PLAN_LEVEL` — the Department's own vocabulary: `DP`, `LAP` or `SDZ`.
	 */
	plan_level: string
	valid_from: string | null
	/**
	 * `PLAN_TO`, the plan's own stated end.
	 */
	valid_to: string | null
	/**
	 * `CURRENT_PLAN`, carried as published: `1` means not superseded, not in force today, which is `valid_to`.
	 */
	current_plan: number
}

/**
 * Who adopted the plan.
 */
export interface ZoningJurisdictionTable {
	jurisdiction_id: string
	name: string
	/**
	 * The publisher's own code, verbatim — `Fl` for Fingal against `CL`, `CO`, `DU` — never repaired.
	 */
	source_code: string
	country: string
}

/**
 * A publisher's declared vocabulary, as shipped, per scheme — plus the values
 * the data uses that the publisher never declared.
 */
export interface ZoningVocabularyTable {
	/**
	 * `IE-GZT`, `IE-SZO`, `IE-plan-level`, or `IE-local:<authority code>`.
	 */
	scheme: string
	code: string
	/**
	 * The publisher's own words.
	 *
	 * For an observed-but-undeclared code this is the description the data carries on its rows,
	 * or the code itself where the data carries none, never a label this package wrote.
	 */
	label: string
	/**
	 * The publisher's own definition, where it is retrievable.
	 */
	definition: string | null
	/**
	 * NULL for the Irish generic types: their definitions were not retrievable, and this column is never
	 * filled with a plausible one.
	 */
	definition_url: string | null
	/**
	 * `1` where the publisher declares this code in its own domain, `0` where the code appears only in the
	 * data; folding the two would hide a source-schema change or invent a declaration.
	 */
	declared: number
	/**
	 * How many rows of this artifact carry the code.
	 *
	 * A census a reader checks a closed domain against, rather than a claim about the world.
	 */
	observed_rows: number
}

/**
 * A publisher's own mapping between two schemes, where it publishes one as a table.
 *
 * Empty for Ireland: the mapping is not a function of the (authority, local code) pair, so it lives
 * on `zoning_area` per row and {@linkcode assertCrosswalkIsNotATable} refuses a build that writes edges.
 */
export interface ZoningCrosswalkEdgeTable {
	from_scheme: string
	from_code: string
	to_scheme: string
	to_code: string
	/**
	 * The body that authored this edge.
	 *
	 * Never us.
	 */
	authored_by: string
}

/**
 * Per (cell, polygon): does the polygon cover the whole cell, or only part of it?
 *
 * Keyed on the polygon rather than a code, because a zoning answer is the polygon and two authorities'
 * plans can name the same code for different things.
 */
export interface ZoningCellTable {
	/**
	 * 48-bit short H3 cell.
	 *
	 * Mixed-resolution: `whole` rows are compacted parent-ward, `partial` rows stay
	 * at the resolution the feature was indexed at.
	 */
	h3_cell: number
	/**
	 * The resolution this row's cell was captured at.
	 *
	 * A short cell does not name its own resolution, and a table that mixes them cannot be probed without it.
	 */
	resolution: number
	area_id: string
	/**
	 * One of {@link ZoningCellContainment}.
	 */
	containment: string
}

/**
 * The authority's own statement of what it mapped.
 *
 * One row per statement, never derived from the zoning polygons: the union of zoned areas is not the area
 * the authority examined, and deriving a footprint from it is forbidden.
 */
export interface ZoningMappedExtentTable {
	extent_id: string
	source: string
	statement: string
	statement_url: string
	effective_date: string | null
	min_lat: number
	min_lon: number
	max_lat: number
	max_lon: number
}

/**
 * Pass to `new DatabaseClient<ZoningDatabase>(...)`.
 */
export interface ZoningDatabase extends layerschemadatabase {
	zoning_area: ZoningAreaTable
	zoning_plan: ZoningPlanTable
	zoning_jurisdiction: ZoningJurisdictionTable
	zoning_vocabulary: ZoningVocabularyTable
	zoning_crosswalk_edge: ZoningCrosswalkEdgeTable
	zoning_cell: ZoningCellTable
	zoning_mapped_extent: ZoningMappedExtentTable
}

/**
 * The subset of a Kysely handle the DDL touches.
 *
 * Same reasoning as `layerschemahandle`: Kysely is invariant in its schema parameter,
 * so naming only the members these functions call lets a caller pass its own wider handle.
 */
export type ZoningSchemaHandle = Pick<Kysely<ZoningDatabase>, "schema">

/**
 * Create `zoning_area`.
 *
 * A plain rowid table on purpose.
 * The `rings` blob is exactly the payload `without rowid` penalizes.
 */
export async function createZoningAreaTable(db: ZoningSchemaHandle): Promise<void> {
	const table = db.schema
		.createTable("zoning_area")
		.addColumn("area_id", "text", (c) => c.primaryKey())
		.addColumn("jurisdiction_id", "text", (c) => c.notNull())
		.addColumn("plan_id", "text", (c) => c.notNull())
		.addColumn("local_code", "text", (c) => c.notNull())
		.addColumn("local_description", "text")
		.addColumn("local_code_url", "text")
		.addColumn("crosswalk_code", "text")
		.addColumn("crosswalk_scheme", "text")
		.addColumn("crosswalk_description", "text")
		.addColumn("crosswalk_rollup", "text")
		.addColumn("provenance_grade", "text", (c) => c.notNull())

	const bounded = addBoundingBoxColumns(table)
		.addColumn("ring_count", "integer", (c) => c.notNull())
		.addColumn("signed_area_m2", "real", (c) => c.notNull())

	await addRingsColumn(bounded)
		// `not NULL` alone accepts `''`, so the value set and the blank are refused separately.
		.addCheckConstraint(
			"zoning_area_provenance_grade_declared",
			sql`provenance_grade in ('authoritative', 'inferred') and trim(provenance_grade) != ''`
		)
		// A blank local code would read as a zone the authority left unnamed, so storage refuses it.
		.addCheckConstraint("zoning_area_local_code_not_blank", sql`trim(local_code) != ''`)
		.execute()
}

/**
 * Create `zoning_plan`.
 */
export async function createZoningPlanTable(db: ZoningSchemaHandle): Promise<void> {
	await db.schema
		.createTable("zoning_plan")
		.addColumn("plan_id", "text", (c) => c.primaryKey())
		.addColumn("jurisdiction_id", "text", (c) => c.notNull())
		.addColumn("plan_name", "text", (c) => c.notNull())
		.addColumn("plan_level", "text", (c) => c.notNull())
		.addColumn("valid_from", "text")
		.addColumn("valid_to", "text")
		.addColumn("current_plan", "integer", (c) => c.notNull())
		.execute()
}

/**
 * Create `zoning_jurisdiction`.
 */
export async function createZoningJurisdictionTable(db: ZoningSchemaHandle): Promise<void> {
	await db.schema
		.createTable("zoning_jurisdiction")
		.addColumn("jurisdiction_id", "text", (c) => c.primaryKey())
		.addColumn("name", "text", (c) => c.notNull())
		.addColumn("source_code", "text", (c) => c.notNull())
		.addColumn("country", "text", (c) => c.notNull())
		.execute()
}

/**
 * Create `zoning_vocabulary`.
 */
export async function createZoningVocabularyTable(db: ZoningSchemaHandle): Promise<void> {
	await db.schema
		.createTable("zoning_vocabulary")
		.addColumn("scheme", "text", (c) => c.notNull())
		.addColumn("code", "text", (c) => c.notNull())
		.addColumn("label", "text", (c) => c.notNull())
		.addColumn("definition", "text")
		.addColumn("definition_url", "text")
		.addColumn("declared", "integer", (c) => c.notNull())
		.addColumn("observed_rows", "integer", (c) => c.notNull())
		.addPrimaryKeyConstraint("zoning_vocabulary_pk", ["scheme", "code"])
		.execute()
}

/**
 * Create `zoning_crosswalk_edge`, empty for Ireland.
 */
export async function createZoningCrosswalkEdgeTable(db: ZoningSchemaHandle): Promise<void> {
	await db.schema
		.createTable("zoning_crosswalk_edge")
		.addColumn("from_scheme", "text", (c) => c.notNull())
		.addColumn("from_code", "text", (c) => c.notNull())
		.addColumn("to_scheme", "text", (c) => c.notNull())
		.addColumn("to_code", "text", (c) => c.notNull())
		.addColumn("authored_by", "text", (c) => c.notNull())
		.addPrimaryKeyConstraint("zoning_crosswalk_edge_pk", ["from_scheme", "from_code", "to_scheme", "to_code"])
		.execute()
}

/**
 * Create `zoning_cell` — the summary tier.
 *
 * Small fixed-width rows probed by their exact primary key, which is the `without rowid` shape.
 */
export async function createZoningCellTable(db: ZoningSchemaHandle): Promise<void> {
	const table = db.schema.createTable("zoning_cell")

	await addCellIndexColumns(table, "area_id")
		.addPrimaryKeyConstraint("zoning_cell_pk", ["h3_cell", "area_id"])
		// `without rowid` has no first-class builder, so the raw modifier is the fallback.
		.modifyEnd(sql`without rowid`)
		.execute()
}

/**
 * Create `zoning_mapped_extent`, empty while the reader refuses a stronger coverage basis.
 */
export async function createZoningMappedExtentTable(db: ZoningSchemaHandle): Promise<void> {
	const table = db.schema
		.createTable("zoning_mapped_extent")
		.addColumn("extent_id", "text", (c) => c.primaryKey())
		.addColumn("source", "text", (c) => c.notNull())
		.addColumn("statement", "text", (c) => c.notNull())
		.addColumn("statement_url", "text", (c) => c.notNull())
		.addColumn("effective_date", "text")

	await addBoundingBoxColumns(table).execute()
}

/**
 * Every domain table this layer owns, in dependency order.
 */
export async function createZoningTables(db: ZoningSchemaHandle): Promise<void> {
	await createZoningJurisdictionTable(db)
	await createZoningPlanTable(db)
	await createZoningAreaTable(db)
	await createZoningVocabularyTable(db)
	await createZoningCrosswalkEdgeTable(db)
	await createZoningCellTable(db)
	await createZoningMappedExtentTable(db)
}
