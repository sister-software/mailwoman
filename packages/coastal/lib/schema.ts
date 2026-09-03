/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Typed schema for `coastal-england.db` — the scenario-scoped two-tier polygon layer: the authority's
 *   unsimplified rings as the truth table, an H3 cell table above them as the summary, the two
 *   ground-instability layers apart from both, plus the layer-contract tables from `@mailwoman/core/layers`.
 *
 *   `area_id` IS SCOPED BY SCENARIO, AND THE KEY INSIDE A SCENARIO IS THE AUTHORITY'S FEATURE ID — NOT ITS
 *   FRONTAGE ID. The same frontage appears in all twelve scenario layers with a different distance each
 *   time, so the source's `frontageid` is not unique across the artifact; measured, it is not unique WITHIN
 *   a layer either. `NCERM_NFI_2055_0CC` holds 7,379 features over 7,369 distinct frontage ids (frontage
 *   39260 alone appears ten times), and the twelve layers together hold 89,211 features over far fewer
 *   frontages — 835 rows would have collided. So the key is `<scenario key>:<OBJECTID>` and `frontage_id`
 *   rides as an attribute, which is what a reader joins on when it wants the frontage rather than the row.
 *
 *   THE CELL TABLE NAMES POLYGONS, NOT CLASSES, AND THAT IS WHERE THIS LAYER DIFFERS FROM THE FLOOD ONE.
 *   A flood answer is a zone code from a two-value domain, so its index accumulates per code. An erosion
 *   answer is a specific frontage polygon carrying its own distance, policy and defence, so the index names
 *   the polygon and the scenario it belongs to. Overlap is real rather than theoretical: 3,727 of the 7,492
 *   features on `NCERM_SMP_2105_95CC` carry a non-zero `maxoverlap`, so a cell can name several polygons of
 *   one scenario and a reading reports every one that contains the point.
 *
 *   `WITHOUT ROWID` ON THE CELL TABLE AND NEVER ON THE GEOMETRY TABLES. Small fixed-width rows probed by
 *   their exact primary key belong in the B-tree; a row carrying a geometry blob does not — clustering it
 *   into the B-tree makes every index page a geometry page.
 *
 *   THE WHOLE-CELL SET IS COMPACTED PER FEATURE, SO IT IS MIXED-RESOLUTION. A row therefore carries its own
 *   `resolution`, and a probe walks `cellToParent` from the index resolution up to the coarsest resolution
 *   present. `layer_coverage` is NOT compacted and stays single-resolution, because
 *   `recoverCoverageResolution` recovers one resolution from the stored cells and throws on a table that
 *   mixes them.
 */

import type { LayerContractDatabase } from "@mailwoman/core/layers"
import { addBoundingBoxColumns, addCellIndexColumns, addRingGeometryColumns } from "@mailwoman/sqlite/schema-columns"
import { sql, type Kysely } from "kysely"

/**
 * Whether an H3 cell lies wholly inside an erosion zone, or is crossed by its boundary.
 */
export const CoastalCellContainment = {
	/**
	 * Every point in the cell is inside the zone. Answered from the index alone, with no geometry read.
	 */
	Whole: "whole",
	/**
	 * The zone boundary crosses the cell. The index has narrowed the candidate polygons; the point test decides.
	 */
	Partial: "partial",
} as const

export type CoastalCellContainment = (typeof CoastalCellContainment)[keyof typeof CoastalCellContainment]

/**
 * One authority erosion polygon, verbatim. A plain rowid table: it holds a geometry blob, which is the one shape
 * `WITHOUT ROWID` hurts.
 */
export interface CoastalZoneAreaTable {
	/**
	 * `<scenario key>:<OBJECTID>` — see this file's header for why the frontage id cannot serve.
	 */
	area_id: string
	/**
	 * One of `NCERM_SCENARIOS`' keys. Carried as its own column rather than only inside `area_id`, because every probe is
	 * scenario-scoped and a probe that had to parse a key would be parsing a key.
	 */
	scenario_key: string
	/**
	 * `NFI` or `SMP` — the management scenario, part of the claim.
	 */
	management: string
	/**
	 * 2055 (Medium Term) or 2105 (Long Term).
	 */
	horizon: number
	/**
	 * `0CC`, `70CC` or `95CC`.
	 */
	climate_allowance: string
	/**
	 * The authority's `frontageid`. Not unique — see the header.
	 */
	frontage_id: number
	/**
	 * Cumulative erosion distance in metres, from the scenario's own distance column. Measured range 0–386 m on
	 * NFI/2055/0CC and 0–1,053 m on SMP/2105/95CC, with no nulls in either.
	 */
	distance_m: number
	smp_no: number | null
	smp_name: string | null
	smp_pu: string | null
	/**
	 * `mt_smp`, verbatim. NULL on NFI rows, where the source publishes no policy because no intervention is assumed.
	 */
	mt_policy: string | null
	/**
	 * `mt_smp_int`, verbatim.
	 */
	mt_policy_interp: string | null
	lt_policy: string | null
	lt_policy_interp: string | null
	/**
	 * `def_type`, verbatim. Compared case-folded, never stored folded.
	 */
	defence_type: string | null
	/**
	 * 2024, or 0 on the 87 anomalous rows. Carried, never coerced: the Environment Agency documents no meaning for them.
	 */
	published_year: number | null
	/**
	 * The source's own `maxoverlap`, in metres. Non-zero on 3,727 of 7,492 rows on one measured layer, which is why a
	 * reading can name several polygons.
	 */
	max_overlap: number | null
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
 * Per (cell, polygon): does the polygon cover the whole cell, or only part of it?
 *
 * Keyed on the polygon rather than on a class, because an erosion answer IS the polygon — its distance, its policy and
 * its defence are per feature. `scenario_key` is a column so a scenario-scoped probe reads one cell's rows and keeps
 * the scenario it asked for, without ever seeing another scenario's answer.
 */
export interface CoastalZoneCellTable {
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
	scenario_key: string
	area_id: string
	/**
	 * One of {@link CoastalCellContainment}.
	 */
	containment: string
}

/**
 * NCERM's two ground-instability layers — a DIFFERENT HAZARD, kept apart so a reader cannot answer an erosion question
 * from a landslide polygon.
 *
 * 160 rows in total (80 per layer, sharing feature ids and attributes and differing in geometry), which is why they
 * carry no cell index: a bounding-box scan over 160 rows costs less than the index would, and the absence of an index
 * is itself the structure that keeps this hazard off the erosion probe.
 */
export interface CoastalGroundInstabilityTable {
	/**
	 * `<kind>:<OBJECTID>` — the two layers reuse feature ids 1–80.
	 */
	area_id: string
	/**
	 * `zone` or `recession`.
	 */
	kind: string
	location: string | null
	local_authority: string | null
	smp_no: number | null
	smp_name: string | null
	/**
	 * `smp_pu1`…`smp_pu5` joined with a comma, blanks dropped — the policy units the feature spans.
	 */
	smp_policy_units: string | null
	/**
	 * `rearscarpr`, verbatim. Published as a string carrying 0, 10, 50 or 100.
	 */
	rear_scarp_probability: string | null
	min_lat: number
	min_lon: number
	max_lat: number
	max_lon: number
	rings: Uint8Array
}

/**
 * The authority's MAPPED FOOTPRINT — one row per statement, never derived from the hazard polygons.
 *
 * EMPTY IN THIS EDITION, AND ITS EMPTINESS IS THE CLAIM. The Environment Agency publishes no coverage statement for
 * NCERM, so there is no footprint to record and `layer_coverage` carries `basis = source_present`. The table exists
 * because the day a footprint source is settled — the Shoreline Management Plan Mapping record, or the frontage
 * geometry behind `frontageid`; see the workspace README — is the day this layer may write a stronger basis, and the
 * row that licenses it belongs beside the coverage rather than in a code change nobody can audit.
 *
 * Deriving a footprint from the union of the erosion polygons is forbidden: the union of "at risk" areas is not the
 * mapped area, and the difference is the whole content of a negative answer.
 */
export interface CoastalMappedExtentTable {
	extent_id: string
	/**
	 * Which published product this footprint came from.
	 */
	source: string
	/**
	 * The coverage statement, verbatim.
	 */
	statement: string
	statement_url: string
	effective_date: string | null
	min_lat: number
	min_lon: number
	max_lat: number
	max_lon: number
}

/**
 * The authority's declared scenario and policy domains, as shipped, so a reader can refuse a value the layer was never
 * built to hold and quote the authority's own words for one it holds.
 */
export interface CoastalScenarioVocabularyTable {
	/**
	 * `scenario_key`, `policy_interpretation`, `policy`, or `defence_type`.
	 */
	field: string
	value: string
	label: string
	definition: string
	definition_url: string
}

/**
 * Pass to `new DatabaseClient<CoastalDatabase>(...)`.
 */
export interface CoastalDatabase extends LayerContractDatabase {
	coastal_zone_area: CoastalZoneAreaTable
	coastal_zone_cell: CoastalZoneCellTable
	coastal_ground_instability: CoastalGroundInstabilityTable
	coastal_mapped_extent: CoastalMappedExtentTable
	coastal_scenario_vocabulary: CoastalScenarioVocabularyTable
}

/**
 * The slice of a Kysely handle the DDL touches. Same reasoning as `LayerContractHandle`: Kysely is invariant in its
 * schema parameter, so naming only the members these functions call lets a caller pass its own wider handle.
 */
export type CoastalSchemaHandle = Pick<Kysely<CoastalDatabase>, "schema">

/**
 * Create `coastal_zone_area`. A PLAIN rowid table on purpose — the `rings` blob is exactly the payload `WITHOUT ROWID`
 * penalizes.
 */
export async function createCoastalZoneAreaTable(db: CoastalSchemaHandle): Promise<void> {
	const table = db.schema
		.createTable("coastal_zone_area")
		.addColumn("area_id", "text", (c) => c.primaryKey())
		.addColumn("scenario_key", "text", (c) => c.notNull())
		.addColumn("management", "text", (c) => c.notNull())
		.addColumn("horizon", "integer", (c) => c.notNull())
		.addColumn("climate_allowance", "text", (c) => c.notNull())
		.addColumn("frontage_id", "integer", (c) => c.notNull())
		.addColumn("distance_m", "real", (c) => c.notNull())
		.addColumn("smp_no", "integer")
		.addColumn("smp_name", "text")
		.addColumn("smp_pu", "text")
		.addColumn("mt_policy", "text")
		.addColumn("mt_policy_interp", "text")
		.addColumn("lt_policy", "text")
		.addColumn("lt_policy_interp", "text")
		.addColumn("defence_type", "text")
		.addColumn("published_year", "integer")
		.addColumn("max_overlap", "real")

	await addRingGeometryColumns(table).execute()
}

/**
 * Create `coastal_zone_cell` — the summary tier. Small fixed-width rows probed by their exact primary key, which is the
 * `WITHOUT ROWID` shape.
 */
export async function createCoastalZoneCellTable(db: CoastalSchemaHandle): Promise<void> {
	const table = db.schema.createTable("coastal_zone_cell")

	await addCellIndexColumns(table, ["scenario_key", "area_id"])
		.addPrimaryKeyConstraint("coastal_zone_cell_pk", ["h3_cell", "area_id"])
		// `WITHOUT ROWID` has no first-class builder; the raw modifier is the idiomatic fallback.
		.modifyEnd(sql`without rowid`)
		.execute()
}

/**
 * Create `coastal_ground_instability`.
 */
export async function createCoastalGroundInstabilityTable(db: CoastalSchemaHandle): Promise<void> {
	const table = db.schema
		.createTable("coastal_ground_instability")
		.addColumn("area_id", "text", (c) => c.primaryKey())
		.addColumn("kind", "text", (c) => c.notNull())
		.addColumn("location", "text")
		.addColumn("local_authority", "text")
		.addColumn("smp_no", "integer")
		.addColumn("smp_name", "text")
		.addColumn("smp_policy_units", "text")
		.addColumn("rear_scarp_probability", "text")

	await addRingGeometryColumns(table).execute()
}

/**
 * Create `coastal_mapped_extent`. Created empty, and the reader refuses a stronger coverage basis while it stays that
 * way — see the interface's docstring.
 */
export async function createCoastalMappedExtentTable(db: CoastalSchemaHandle): Promise<void> {
	const table = db.schema
		.createTable("coastal_mapped_extent")
		.addColumn("extent_id", "text", (c) => c.primaryKey())
		.addColumn("source", "text", (c) => c.notNull())
		.addColumn("statement", "text", (c) => c.notNull())
		.addColumn("statement_url", "text", (c) => c.notNull())
		.addColumn("effective_date", "text")

	await addBoundingBoxColumns(table).execute()
}

/**
 * Create `coastal_scenario_vocabulary`.
 */
export async function createCoastalScenarioVocabularyTable(db: CoastalSchemaHandle): Promise<void> {
	await db.schema
		.createTable("coastal_scenario_vocabulary")
		.addColumn("field", "text", (c) => c.notNull())
		.addColumn("value", "text", (c) => c.notNull())
		.addColumn("label", "text", (c) => c.notNull())
		.addColumn("definition", "text", (c) => c.notNull())
		.addColumn("definition_url", "text", (c) => c.notNull())
		.addPrimaryKeyConstraint("coastal_scenario_vocabulary_pk", ["field", "value"])
		.execute()
}

/**
 * Every domain table this layer owns, in dependency order.
 */
export async function createCoastalTables(db: CoastalSchemaHandle): Promise<void> {
	await createCoastalZoneAreaTable(db)
	await createCoastalZoneCellTable(db)
	await createCoastalGroundInstabilityTable(db)
	await createCoastalMappedExtentTable(db)
	await createCoastalScenarioVocabularyTable(db)
}
