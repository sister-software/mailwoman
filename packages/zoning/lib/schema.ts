/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Typed schema for `zoning-ireland.db` — the two-tier polygon layer: the authority's unsimplified rings as
 *   the truth table, an H3 cell table above them as the summary, the plan and jurisdiction a zone belongs to,
 *   the published vocabularies, and the layer-contract tables from `@mailwoman/core/layers`.
 *
 *   THE LOCAL CODE IS `NOT NULL` AND THE CROSSWALK IS NULLABLE, WHICH IS THE VOCABULARY DECISION AS A
 *   CONSTRAINT. A source with no crosswalk produces a complete row; a source with no local code does not. The
 *   Department's own item description is what this transcribes: its national scheme "complements (rather than
 *   replaces) the existing statutory zoning used for each individual plan".
 *
 *   `provenance_grade` IS A COLUMN WITH A `CHECK`, NOT A CONVENTION. `NOT NULL` alone accepts `''`, and a
 *   blank matches neither half of every read that splits on grade — so the constraint refuses a blank as well
 *   as an unknown value. This is `packages/filer`'s discipline applied unchanged, and the reason it is
 *   compulsory here is licensing as much as epistemics: an observed land-use layer is ODbL, and merging one
 *   of its rows into this table would relicense the table.
 *
 *   `signed_area_m2` IS THE INGEST'S OWN RECEIPT AND ITS SIGN IS LOAD-BEARING. The service encodes hole roles
 *   by ring orientation with clockwise as the exterior, so a correctly-read feature stores a POSITIVE signed
 *   sum; the national total of those sums is what the build compares against the Department's own
 *   `Shape__Area` statistic. Read with the holes it is 5,444.5 km²; read without them, 5,666.6 km².
 *
 *   `WITHOUT ROWID` ON THE CELL TABLE AND NEVER ON THE GEOMETRY TABLE. Small fixed-width rows probed by their
 *   exact primary key belong in the B-tree; a row carrying a geometry blob does not — clustering it into the
 *   B-tree makes every index page a geometry page.
 *
 *   THE WHOLE-CELL SET IS COMPACTED PER FEATURE, SO IT IS MIXED-RESOLUTION. A row therefore carries its own
 *   `resolution`, and a probe walks `cellToParent` from the index resolution up to the coarsest resolution
 *   present. `layer_coverage` is NOT compacted and stays single-resolution, because `recoverShortCellResolution`
 *   recovers one resolution from the stored cells and throws on a table that mixes them.
 */

import type { LayerContractDatabase } from "@mailwoman/core/layers"
import { addBoundingBoxColumns, addCellIndexColumns, addRingsColumn } from "@mailwoman/sqlite/schema-columns"
import { sql, type Kysely } from "kysely"

/**
 * Whether an H3 cell lies wholly inside a zoning polygon, or is crossed by its boundary.
 */
export const ZoningCellContainment = {
	/**
	 * Every point in the cell is inside the zone. Answered from the index alone, with no geometry read.
	 */
	Whole: "whole",
	/**
	 * The zone boundary crosses the cell. The index has narrowed the candidate polygons; the point test decides.
	 */
	Partial: "partial",
} as const

export type ZoningCellContainment = (typeof ZoningCellContainment)[keyof typeof ZoningCellContainment]

/**
 * One authority zoning polygon, verbatim. A plain rowid table: it holds a geometry blob, which is the one shape
 * `WITHOUT ROWID` hurts.
 */
export interface ZoningAreaTable {
	/**
	 * The authority's own feature id, as published. Unique across the product — measured, `OBJECTID` runs 1 to 85,330
	 * with no repeat — so it needs no scoping prefix, and a prefix would put this package's key into a column that claims
	 * to be the publisher's.
	 */
	area_id: string
	/**
	 * The authority that adopted the plan. FK to `zoning_jurisdiction`.
	 */
	jurisdiction_id: string
	/**
	 * The plan this zone belongs to. FK to `zoning_plan`. A zone without a plan is not a claim: it exists inside a named
	 * Development Plan or Local Area Plan with a stated validity window, and a layer that dropped the plan and kept the
	 * zone would be answering a question no authority asked.
	 */
	plan_id: string
	/**
	 * `ZONE_ORIG` — THE AUTHORITY'S OWN ZONE CODE, VERBATIM, in its own spelling including case and trailing space.
	 * Compared case-insensitively where it must be compared; never stored normalized.
	 */
	local_code: string
	/**
	 * `ZONE_DESC` — the authority's own description of that code.
	 */
	local_description: string | null
	/**
	 * `ZONE_LINK` — the authority's own link to the plan text. A live host, unlike the crosswalk's.
	 */
	local_code_url: string | null
	/**
	 * `ZONE_GZT` — the Department's national generic type, BESIDE the local code and never instead of it. NULL where a
	 * publisher ships no crosswalk.
	 */
	crosswalk_code: string | null
	/**
	 * Which crosswalk `crosswalk_code` belongs to. NULL with the above.
	 */
	crosswalk_scheme: string | null
	/**
	 * `GZT_DESC` — the Department's own description of the generic type, as published on the row.
	 */
	crosswalk_description: string | null
	/**
	 * `SZO` — a coarser code from the SAME authority, carried as published rather than derived.
	 */
	crosswalk_rollup: string | null
	/**
	 * One of {@link ProvenanceGrade}. `NOT NULL` with a `CHECK` that refuses a blank.
	 */
	provenance_grade: string
	min_lat: number
	min_lon: number
	max_lat: number
	max_lon: number
	/**
	 * How many rings the source published for this feature — with `signed_area_m2`, the ingest's own receipt that the
	 * orientation was read rather than assumed.
	 */
	ring_count: number
	/**
	 * The signed ring sum, in square metres, POSITIVE under this service's clockwise-exterior convention.
	 */
	signed_area_m2: number
	/**
	 * The authority's ring coordinates, UNSIMPLIFIED, with hole roles RESOLVED — see `ring-roles.ts` for the resolution
	 * and `rings.ts` for the layout and the point test.
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
	 * `CURRENT_PLAN`, carried as published.
	 *
	 * IT DOES NOT MEAN "IN FORCE TODAY". Every row of the Current layer carries `1`, which the domain defines as `Current
	 * plan` against `Expired and not replaced` and `Expired and replaced` — so it means "not superseded". Whether the
	 * plan's own window has closed is `valid_to`, and it is a separate fact.
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
	 * The publisher's own code, verbatim. `Fl` for Fingal against `CL`, `CO`, `DU` for the rest — DO NOT REPAIR.
	 */
	source_code: string
	country: string
}

/**
 * A publisher's declared vocabulary, as shipped, per scheme — plus the values the DATA uses that the publisher never
 * declared.
 */
export interface ZoningVocabularyTable {
	/**
	 * `IE-GZT`, `IE-SZO`, `IE-PLAN-LEVEL`, or `IE-LOCAL:<authority code>`.
	 */
	scheme: string
	code: string
	/**
	 * The publisher's own words. For an observed-but-undeclared code this is the description the data carries on its
	 * rows, or the code itself where the data carries none — never a label this package wrote.
	 */
	label: string
	/**
	 * The publisher's own definition, where it is retrievable.
	 */
	definition: string | null
	/**
	 * NULL for the Irish generic types. Every one of the 85,330 rows links its definition to `viewer.myplan.ie`, which
	 * has no A or AAAA record, and three candidate replacements on the live host answer HTTP 404 — so the definitions
	 * behind the 54 code-to-label pairs were not retrievable and this column is not filled in with a plausible one.
	 */
	definition_url: string | null
	/**
	 * `1` where the publisher DECLARES this code in its own domain, `0` where the code appears only in the data.
	 *
	 * FOLDING THE TWO WOULD EITHER HIDE A SOURCE-SCHEMA CHANGE OR INVENT A DECLARATION. Ireland declares 54 generic types
	 * and its data uses 55: `N/A` appears on 4 rows and in no domain.
	 */
	declared: number
	/**
	 * How many rows of this artifact carry the code. A census a reader checks a closed domain against, rather than a
	 * claim about the world.
	 */
	observed_rows: number
}

/**
 * A publisher's OWN mapping between two schemes, where it publishes one AS A TABLE.
 *
 * EMPTY FOR IRELAND, AND THE EMPTINESS IS A MEASUREMENT. The Department's generic type is assigned PER POLYGON, not per
 * code: 52 of the 795 (authority, local code) pairs take more than one generic type inside a single authority — Cork
 * County Council's `Special Policy Area` takes 14 and its `Green Infrastructure` 12 — so the mapping is not a function
 * of the pair and no edge table can carry it without inventing one. The mapping lives on `zoning_area`, per row, where
 * the Department put it. {@linkcode assertCrosswalkIsNotATable} refuses a build that would write edges while such a
 * pair exists.
 */
export interface ZoningCrosswalkEdgeTable {
	from_scheme: string
	from_code: string
	to_scheme: string
	to_code: string
	/**
	 * The body that authored THIS edge. Never us.
	 */
	authored_by: string
}

/**
 * Per (cell, polygon): does the polygon cover the whole cell, or only part of it?
 *
 * KEYED ON THE POLYGON RATHER THAN ON A CODE, because a zoning answer IS the polygon — its local code, its plan and its
 * authority are per feature, and two authorities' plans can name the same code for different things.
 */
export interface ZoningCellTable {
	/**
	 * 48-bit short H3 cell. Mixed-resolution: `whole` rows are compacted parent-ward, `partial` rows stay at the
	 * resolution the feature was indexed at.
	 */
	h3_cell: number
	/**
	 * The resolution this row's cell was captured at. A short cell does not name its own resolution, and a table that
	 * mixes them cannot be probed without it.
	 */
	resolution: number
	area_id: string
	/**
	 * One of {@link ZoningCellContainment}.
	 */
	containment: string
}

/**
 * The authority's own statement of what it MAPPED — one row per statement, never derived from the zoning polygons.
 *
 * EMPTY IN THIS EDITION, AND ITS EMPTINESS IS THE CLAIM. The Department states "Awaiting data for some Local
 * Authorities
 *
 * - Please see map viewer for coverage details" and publishes that detail only inside a map application, so there is no
 *   footprint to record and `layer_coverage` carries `basis = source_present`. Donegal County Council's absence — the
 *   one local authority of 31 missing from the layer — was recovered by measuring `LA_CODE`, not read from a
 *   statement.
 *
 * Deriving a footprint from the union of the zoning polygons is forbidden: the union of zoned areas is not the area the
 * authority examined, and the difference is the whole content of a negative answer. One authority's drafting convention
 * moves the national zoned-area figure by 41% on its own — Meath County Council zones its entire rural remainder as one
 * 2,232 km² polygon, against 32.5 km² for the next largest in the country — so the union is not even a stable shape.
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
export interface ZoningDatabase extends LayerContractDatabase {
	zoning_area: ZoningAreaTable
	zoning_plan: ZoningPlanTable
	zoning_jurisdiction: ZoningJurisdictionTable
	zoning_vocabulary: ZoningVocabularyTable
	zoning_crosswalk_edge: ZoningCrosswalkEdgeTable
	zoning_cell: ZoningCellTable
	zoning_mapped_extent: ZoningMappedExtentTable
}

/**
 * The slice of a Kysely handle the DDL touches. Same reasoning as `LayerContractHandle`: Kysely is invariant in its
 * schema parameter, so naming only the members these functions call lets a caller pass its own wider handle.
 */
export type ZoningSchemaHandle = Pick<Kysely<ZoningDatabase>, "schema">

/**
 * Create `zoning_area`. A PLAIN rowid table on purpose — the `rings` blob is exactly the payload `WITHOUT ROWID`
 * penalizes.
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
		// ONE GRADE PER CLAIM, AND A BLANK IS NOT ONE. `NOT NULL` alone accepts `''`, which matches neither half of every
		// read that splits on grade — so the value set and the blank are refused separately, and the second half is the one
		// a schema without it loses.
		.addCheckConstraint(
			"zoning_area_provenance_grade_declared",
			sql`provenance_grade in ('authoritative', 'inferred') and trim(provenance_grade) != ''`
		)
		// The local code is what this layer exists to repeat, so an empty one is refused at the storage layer rather than
		// only at the ingest: a blank would read as a zone the authority named nothing.
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
 * Create `zoning_crosswalk_edge`. Created empty for Ireland — see the interface's docstring.
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
 * Create `zoning_cell` — the summary tier. Small fixed-width rows probed by their exact primary key, which is the
 * `WITHOUT ROWID` shape.
 */
export async function createZoningCellTable(db: ZoningSchemaHandle): Promise<void> {
	const table = db.schema.createTable("zoning_cell")

	await addCellIndexColumns(table, "area_id")
		.addPrimaryKeyConstraint("zoning_cell_pk", ["h3_cell", "area_id"])
		// `WITHOUT ROWID` has no first-class builder; the raw modifier is the idiomatic fallback.
		.modifyEnd(sql`without rowid`)
		.execute()
}

/**
 * Create `zoning_mapped_extent`. Created empty, and the reader refuses a stronger coverage basis while it stays that
 * way — see the interface's docstring.
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
