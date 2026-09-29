/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Typed schema for `coastal-england.db`. The two-tier polygon layer stores the authority's unsimplified rings as
 *   the truth table and H3 cells as a summary. Two ground-instability layers remain separate from both. The schema
 *   also includes the layer-interface tables from `@mailwoman/core/layers`.
 *
 *   `area_id` is scoped by scenario. Within a scenario, the authority's feature ID is the key. A frontage ID cannot
 *   serve as the key because each frontage appears in all twelve scenarios with a different distance. The source's
 *   `frontageid` is also non-unique within a layer. `NCERM_NFI_2055_0CC` contains 7,379 features and 7,369 distinct
 *   frontage IDs. Frontage 39260 appears ten times. Across all twelve layers, 89,211 features share fewer frontage
 *   IDs. A frontage-only key would collide on 835 rows. The key is `<scenario key>:<objectid>`. `frontage_id` remains
 *   an attribute for readers that need to join by frontage.
 *
 *   The cell table names polygons instead of classes. The flood layer returns a zone code from a two-value domain.
 *   Its index accumulates cells by code. An erosion answer identifies a frontage polygon
 *   with its own distance, policy and defence. The index stores a key for each polygon and scenario. Overlap occurs
 *   in the source: 3,727 of 7,492 features on `NCERM_SMP_2105_95CC` carry a non-zero `maxoverlap`. A cell can name
 *   several polygons in one scenario. A reading reports each polygon that contains the point.
 *
 *   Cell tables use `without rowid`; geometry tables use ordinary rowids. Small fixed-width rows are probed by their
 *   exact primary key, so they fit the B-tree. A geometry blob would make every index page a geometry page if stored
 *   in that B-tree.
 *
 *   The whole-cell set is compacted per feature, so it uses mixed resolutions. Each row carries its own
 *   `resolution`. A probe walks `cellToParent` from the index resolution up to the coarsest resolution
 *   present. `layer_coverage` remains at one resolution because
 *   `recoverShortCellResolution` from `@mailwoman/spatial` recovers one resolution from the stored cells
 *   and throws when a table mixes them.
 */

import type { layerschemadatabase } from "@mailwoman/core/layers"
import { addBoundingBoxColumns, addCellIndexColumns, addRingGeometryColumns } from "@mailwoman/sqlite/schema-columns"
import { sql, type Kysely } from "kysely"

/**
 * Whether an H3 cell lies wholly inside an erosion zone, or is crossed by its boundary.
 */
export const CoastalCellContainment = {
	/**
	 * Every point in the cell is inside the zone.
	 *
	 * Answered from the index alone, with no geometry read.
	 */
	Whole: "whole",
	/**
	 * The zone boundary crosses the cell.
	 *
	 * The index has narrowed the candidate polygons.
	 * The point test decides.
	 */
	Partial: "partial",
} as const

export type CoastalCellContainment = (typeof CoastalCellContainment)[keyof typeof CoastalCellContainment]

/**
 * One authority erosion polygon, verbatim.
 *
 * A plain rowid table.
 * It holds a geometry blob.
 * `without rowid` stores this shape inefficiently.
 */
export interface CoastalZoneAreaTable {
	/**
	 * `<scenario key>:<objectid>`.
	 *
	 * See this file's header for why the frontage id cannot serve.
	 */
	area_id: string
	/**
	 * One of `NCERM_SCENARIOS`' keys.
	 *
	 * Carried as its own column rather than only inside `area_id`, because every probe is
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
	 * The authority's `frontageid`.
	 *
	 * Not unique — see the header.
	 */
	frontage_id: number
	/**
	 * Cumulative erosion distance in metres, from the scenario's own distance column.
	 *
	 * Measured range 0–386 m on NFI/2055/0CC and 0–1,053 m on SMP/2105/95CC, with no nulls in either.
	 */
	distance_m: number
	smp_no: number | null
	smp_name: string | null
	smp_pu: string | null
	/**
	 * `mt_smp`, verbatim.
	 *
	 * NULL on NFI rows, where the source publishes no policy because no intervention is assumed.
	 */
	mt_policy: string | null
	/**
	 * `mt_smp_int`, verbatim.
	 */
	mt_policy_interp: string | null
	lt_policy: string | null
	lt_policy_interp: string | null
	/**
	 * `def_type`, verbatim.
	 *
	 * Compared case-folded, never stored folded.
	 */
	defence_type: string | null
	/**
	 * 2024, or 0 on the 87 anomalous rows.
	 *
	 * Carried, never coerced: the Environment Agency documents no meaning for them.
	 */
	published_year: number | null
	/**
	 * The source's own `maxoverlap`, in metres.
	 *
	 * One measured layer has non-zero values on 3,727 of 7,492 rows.
	 * A reading can therefore include several polygons.
	 */
	max_overlap: number | null
	min_lat: number
	min_lon: number
	max_lat: number
	max_lon: number
	/**
	 * The authority's ring coordinates, unsimplified.
	 *
	 * `@mailwoman/spatial`'s ring-blob encoding defines the layout.
	 * `pointInEncodedRings` is the point test.
	 */
	rings: Uint8Array
}

/**
 * Per (cell, polygon): does the polygon cover the whole cell, or only part of it?
 *
 * Keyed on the polygon rather than on a class, because an erosion answer is the polygon.
 * Its distance, its policy and its defence are per feature.
 *
 * `scenario_key` is a column so a scenario-scoped probe reads one cell's rows
 * and keeps the scenario it asked for, without ever seeing another scenario's answer.
 */
export interface CoastalZoneCellTable {
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
	 * A short cell does not encode its resolution.
	 * A table that mixes resolutions requires this column for probes.
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
 * Ncerm's two ground-instability layers.
 *
 * These layers describe a different hazard.
 * Their separate table prevents a landslide polygon from answering an erosion query.
 *
 * The two layers contain 160 rows total: 80 per layer.
 * They share feature IDs and attributes but have different geometry.
 *
 * A bounding-box scan over 160 rows costs less than a cell index.
 * The erosion probe also excludes this hazard because the schema has no cell index.
 */
export interface CoastalGroundInstabilityTable {
	/**
	 * `<kind>:<objectid>` — the two layers reuse feature ids 1–80.
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
	 * `rearscarpr`, verbatim.
	 *
	 * Published as a string carrying 0, 10, 50 or 100.
	 */
	rear_scarp_probability: string | null
	min_lat: number
	min_lon: number
	max_lat: number
	max_lon: number
	rings: Uint8Array
}

/**
 * The authority's mapped footprint.
 *
 * One row per statement, never derived from the hazard polygons.
 *
 * This edition leaves the table empty.
 * That empty state is the recorded claim.
 *
 * The Environment Agency publishes no coverage statement for NCERM.
 * There is no footprint to record.
 *
 * `layer_coverage` therefore carries `basis = source_present`.
 *
 * The table supports a future footprint source, such as the Shoreline Management Plan
 * Mapping record or frontage geometry behind `frontageid`; see the workspace readme.
 * Once a source is settled, this layer can record a stronger basis.
 *
 * The evidence belongs beside the coverage so the audit trail remains intact.
 *
 * The footprint cannot come from the union of erosion polygons.
 * The union of "at risk" areas differs from the mapped area.
 * That distinction determines what a negative answer means.
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
 * The authority's declared scenario and policy domains, as shipped, so a reader can refuse a
 * value the layer was never built to hold and quote the authority's own words for one it holds.
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
export interface CoastalDatabase extends layerschemadatabase {
	coastal_zone_area: CoastalZoneAreaTable
	coastal_zone_cell: CoastalZoneCellTable
	coastal_ground_instability: CoastalGroundInstabilityTable
	coastal_mapped_extent: CoastalMappedExtentTable
	coastal_scenario_vocabulary: CoastalScenarioVocabularyTable
}

/**
 * The subset of a Kysely handle the DDL touches.
 *
 * Same reasoning as `layerschemahandle`: Kysely is invariant in its schema parameter,
 * so naming only the members these functions call lets a caller pass its own wider handle.
 */
export type CoastalSchemaHandle = Pick<Kysely<CoastalDatabase>, "schema">

/**
 * Create `coastal_zone_area`.
 *
 * A plain rowid table on purpose.
 * The `rings` blob is exactly the payload `without rowid` penalizes.
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
 * Create `coastal_zone_cell` — the summary tier.
 *
 * These small fixed-width rows are probed by their exact primary key.
 * That access pattern fits `without rowid`.
 */
export async function createCoastalZoneCellTable(db: CoastalSchemaHandle): Promise<void> {
	const table = db.schema.createTable("coastal_zone_cell")

	await addCellIndexColumns(table, ["scenario_key", "area_id"])
		.addPrimaryKeyConstraint("coastal_zone_cell_pk", ["h3_cell", "area_id"])
		// `without rowid` has no first-class builder. The raw modifier is the idiomatic fallback.
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
 * Create `coastal_mapped_extent`.
 *
 * Creates an empty table.
 * The reader refuses a stronger coverage basis while the table remains empty.
 * See the interface docstring.
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
