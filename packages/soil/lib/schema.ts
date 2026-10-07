/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Typed schema for `soil.db`. It defines the polygon truth table, its containment index and the shared reduction
 *   that both consumers read. It also defines the layer-interface tables from `@mailwoman/core/layers`.
 *
 *   {@link SoilMapUnitAreaTable} stores the authority's unsimplified geometry.
 *   {@link SoilMapUnitCellTable} records which cells each delineation reaches and whether it fills them.
 *   {@link SoilCapabilityCellTable} is that index reduced once, at build time, into a per-cell
 *   distribution. A `partial` cell's contribution is weighted by the area it covers. The truth table keeps
 *   unsimplified rings so simplification cannot change those weights silently.
 *
 *   The reduction stores a distribution instead of one winning class. Four separate shares record reasons for
 *   absence. Class 8 is a determination, so it contributes a class share. A fold that places a `notcom` polygon, a water body
 *   and an unrated series into "not arable" would produce a well-formed but wrong answer. The four shares preserve
 *   those distinctions.
 *
 *   Cell tables use `without rowid`; the geometry table uses ordinary rowids. Small fixed-width rows are probed by
 *   their exact primary key, so they fit the B-tree. A geometry blob would make every index page a geometry page if
 *   stored in that B-tree.
 */

import type { layerschemadatabase } from "@mailwoman/core/layers"
import {
	addBoundingBoxColumns,
	addCellIndexColumns,
	addRingGeometryColumns,
	type AreaCellIndexTable,
} from "@mailwoman/sqlite/schema-columns"
import { sql, type Kysely } from "kysely"

/**
 * Whether an H3 cell lies wholly inside one map-unit delineation, or is crossed by its boundary.
 */
export const SoilCellContainment = {
	/**
	 * Every point in the cell is inside the delineation.
	 *
	 * Answered from the index without reading geometry.
	 */
	Whole: "whole",
	/**
	 * The delineation's boundary crosses the cell.
	 *
	 * The index has narrowed the candidates.
	 * The point test decides.
	 */
	Partial: "partial",
} as const

export type SoilCellContainment = (typeof SoilCellContainment)[keyof typeof SoilCellContainment]

/**
 * One map-unit delineation, verbatim.
 *
 * A plain rowid table.
 * It holds a geometry blob.
 * `without rowid` stores this shape inefficiently.
 */
export interface SoilMapUnitAreaTable {
	/**
	 * `<areasymbol>:<ordinal>` identifies the survey area and this delineation's
	 * position in the authority's own shapefile order.
	 *
	 * SSURGO publishes no per-delineation key.
	 * `mukey` identifies the map unit.
	 *
	 * Each map unit has many delineations.
	 * The ordinal distinguishes each delineation row.
	 *
	 * Text allows the source to publish a non-numeric ID without a schema change.
	 */
	area_id: string
	/**
	 * The map unit that contains this delineation.
	 * NRCS uses this key to join every attribute.
	 */
	mukey: string
	areasymbol: string
	min_lat: number
	min_lon: number
	max_lat: number
	max_lon: number
	/**
	 * The authority's ring coordinates, unsimplified.
	 * See `@mailwoman/spatial`'s ring blob for the layout.
	 */
	rings: Uint8Array
}

/**
 * Records whether a delineation covers a whole cell or only part of it.
 *
 * Rows use the delineation as the key because the reduction weights by covered area.
 * Two delineations from one map unit can reach the same cell while covering different ground.
 *
 * `containment` is one of {@link SoilCellContainment}.
 */
export type SoilMapUnitCellTable = AreaCellIndexTable

/**
 * One ssurgo map unit, the attribute row every delineation joins to.
 */
export interface SoilMapUnitTable {
	mukey: string
	areasymbol: string
	/**
	 * The map unit symbol.
	 *
	 * `notcom` and `notpub` are meaningful values here rather than codes to skip.
	 * They mark a polygon the authority drew with no soil mapping behind it.
	 */
	musym: string
	muname: string
	/**
	 * `Consociation` | `Complex` | `Association` | `Undifferentiated group`,
	 * from the authority's declared domain.
	 *
	 * A complex is nrcs's statement that two or more soils are intermingled
	 * and cannot be separated at the mapping scale.
	 * The mixture is the survey's finding rather than this layer's loss.
	 */
	mukind: string | null
	mustatus: string | null
	/**
	 * The full conditional string, verbatim.
	 *
	 * `Not prime farmland` is itself a declared value, while NULL means the map
	 * unit has no farmland classification.
	 */
	farmlndcl: string | null
	/**
	 * Which of {@link FarmlandScope} `farmlndcl` falls under.
	 *
	 * Federal criteria travel between states, while delegated ones do not.
	 *
	 * Derived once at build time so a consumer never has to re-read 7 CFR 657.5 to know
	 * whether two rows are comparable.
	 */
	farmland_scope: string
	/**
	 * Nrcs's own dominant-condition capability class for the map unit, stored rather than recomputed.
	 */
	niccdcd: string | null
	/**
	 * The share that class actually covers.
	 *
	 * The pair is the pattern this layer's cell reduction reproduces at cell grain,
	 * so carrying both makes the two comparable.
	 */
	niccdcdpct: number | null
	/**
	 * Whether this map unit is a polygon with no soil mapping behind it, such as `notcom`,
	 * `notpub`, access denied, or a map unit carrying no components at all.
	 *
	 * Such a map unit contributes to `nodata_share` and never to a class share.
	 */
	no_mapping: number
}

/**
 * A map unit's components, because a map unit is a mixture.
 */
export interface SoilComponentTable {
	cokey: string
	mukey: string
	/**
	 * The component's representative percentage of its map unit, the weight the reduction aggregates by.
	 */
	comppct_r: number
	compname: string | null
	/**
	 * `Miscellaneous area` is what separates not-rateable from unrated: a rock outcrop
	 * or a water body is a component the capability rating does not apply to,
	 * while an unrated series is one the survey did not rate.
	 */
	compkind: string | null
	/**
	 * Nonirrigated Land Capability Class, `"1"`–`"8"`.
	 *
	 * NULL means not rated, never class 8.
	 */
	nirrcapcl: string | null
	/**
	 * Subclass `c` | `e` | `s` | `w`.
	 */
	nirrcapscl: string | null
	/**
	 * The irrigated rating.
	 *
	 * Populated only where irrigation is a considered use, so its absence states that
	 * the rating does not apply rather than anything about the land.
	 * The build stores it without reducing it.
	 */
	irrcapcl: string | null
	irrcapscl: string | null
	/**
	 * The nccpi v3.0 overall index in [0, 1], under its own rule name.
	 *
	 * Never blended with the capability class.
	 */
	nccpi_v3: number | null
}

/**
 * The shared artifact both consumers read, one row per cell with the index reduced once.
 *
 * The result-level observation takes {@link SoilCapabilityCellTable.top_class} with the share it rests
 * on, while the affordance vector takes `class_shares` plus the four absence shares as its axis.
 * One artifact, one aggregation and one set of provenance rows, so the two
 * consumers cannot disagree about what the ground is.
 */
export interface SoilCapabilityCellTable {
	/**
	 * 48-bit short H3 cell at the declared index resolution.
	 *
	 * Single-resolution, unlike {@link SoilMapUnitCellTable}, because a consumer joins
	 * on this table and a mixed-resolution join key cannot serve that.
	 */
	h3_cell: number
	/**
	 * JSON: the authority's class codes mapped to their area-weighted share, sorted by descending share.
	 *
	 * Shares above the declared truncation floor only.
	 * The remainder is in `other_share`.
	 */
	class_shares: string
	/**
	 * Mapped soil components carrying a NULL rating.
	 * The survey did not rate them.
	 */
	unrated_share: number
	/**
	 * Miscellaneous areas (rock outcrop, water) the rating does not apply to.
	 */
	notrateable_share: number
	/**
	 * `notcom`, `notpub` and access-denied map units: a polygon the authority drew,
	 * with no soil mapping behind it.
	 */
	nodata_share: number
	/**
	 * The truncated minority tail.
	 *
	 * Stored explicitly so the five shares always sum to 1 and a reader can see how
	 * much was folded away rather than inferring it from a gap.
	 */
	other_share: number
	/**
	 * The fraction of the cell covered by any map-unit delineation at all.
	 *
	 * The five shares above are normalized over this value and sum to 1 exactly.
	 * A cell at a survey-area edge can fall partly outside every delineation.
	 *
	 * This column prevents the unmapped remainder from deflating every class share.
	 *
	 * This schema prevents an absence from appearing as a small number.
	 * A cell wholly inside the mapped area reads 1.
	 */
	mapped_share: number
	/**
	 * Stores the largest class share and its proportion.
	 *
	 * This gives consumers an at-cell result and follows NRCS's `niccdcd`/`niccdcdpct` pattern.
	 *
	 * NULL when the cell has no class.
	 * This is a valid result.
	 *
	 * A cell that is 100% `unrated_share` is complete and has no capability reading.
	 */
	top_class: string | null
	top_class_share: number | null
	/**
	 * Which weighting produced the shares, one of {@link SOIL_SHARE_WEIGHTING}.
	 *
	 * Stored per row as well as in the manifest.
	 * A later build with different weighting must have a distinct record.
	 */
	weighting: string
	/**
	 * How many delineations reached this cell.
	 *
	 * Supplies the denominator behind each share above.
	 * It also distinguishes a single-delineation cell from a crowded cell.
	 */
	delineations: number
}

/**
 * The authority's mapped footprint, one row per published survey area, derived from the
 * survey-area outline and each area's own metadata rather than from the rated polygons.
 *
 * The survey's §3.2 identifies rated polygons as an invalid source for this footprint.
 * `notcom` and access-denied map units are inside the footprint and have no rating,
 * so a footprint taken from the rated set would report them as unmapped even
 * though the authority has declared exactly what they are.
 */
export interface SoilSurveyAreaTable {
	areasymbol: string
	areaname: string
	/**
	 * The version-established date from `sacatalog.saverest`, the refresh and the manifest's vintage.
	 */
	saverest: string
	saversion: number | null
	/**
	 * The oldest source citation date in the area's own fgdc lineage, the field
	 * survey the republished polygons rest on.
	 *
	 * This date differs from `saverest`.
	 * `IA153` records a 2025-09-09 refresh over a field survey published in 1960.
	 *
	 * The dataset's time-period-of-content ends at the refresh, so it does not state
	 * when the field survey occurred.
	 */
	survey_source_date: string | null
	/**
	 * The title of the source for `survey_source_date`.
	 * It lets readers check the date against its source.
	 */
	survey_source_title: string | null
	/**
	 * The scale of that original source, 15840 for `IA153`'s 1960 survey.
	 */
	source_scale: number | null
	/**
	 * The scale the map units were digitized at, from `legend.projectscale`, 12000 for `IA153`.
	 *
	 * This differs from `source_scale`.
	 * `source_scale` describes survey detail; `mapping_scale` describes drawing detail.
	 */
	mapping_scale: number | null
	/**
	 * The area the authority publishes for the survey area, in acres.
	 *
	 * The independent witness the ring-area check compares against.
	 */
	area_acres: number | null
	min_lat: number
	min_lon: number
	max_lat: number
	max_lon: number
	/**
	 * The number of `layer_coverage` rows this survey area produced and their resolution.
	 */
	coverage_cells: number
	coverage_resolution: number
}

/**
 * The authority's declared domain for one `Choice` column, read out of the `msdomdet.txt` the archive ships.
 *
 * Stored so a reader can refuse a code the layer cannot hold.
 * The artifact also includes the authority's prose definition of "capability class 3"
 * instead of requiring a separate handbook.
 */
export interface SoilVocabularyTable {
	/**
	 * The domain name as nrcs spells it, such as `capability_class`, `capability_subclass`,
	 * `farmland_classification`, `component_kind` or `mapunit_kind`.
	 */
	domain: string
	/**
	 * The value as it appears in the data.
	 */
	code: string
	/**
	 * The authority's own definition of it.
	 */
	definition: string
	/**
	 * Each value's sequence records its order within the authority's domain.
	 */
	sequence: number
}

/**
 * Pass to `new DatabaseClient<SoilDatabase>(...)`.
 */
export interface SoilDatabase extends layerschemadatabase {
	soil_map_unit_area: SoilMapUnitAreaTable
	soil_map_unit_cell: SoilMapUnitCellTable
	soil_map_unit: SoilMapUnitTable
	soil_component: SoilComponentTable
	soil_capability_cell: SoilCapabilityCellTable
	soil_survey_area: SoilSurveyAreaTable
	soil_vocabulary: SoilVocabularyTable
}

/**
 * The subset of a Kysely handle the DDL touches.
 *
 * Kysely is invariant in its schema parameter, so naming only the members these
 * functions call lets a caller pass its own wider handle.
 */
export type SoilSchemaHandle = Pick<Kysely<SoilDatabase>, "schema">

/**
 * Create `soil_map_unit_area`.
 *
 * A plain rowid table on purpose.
 * The `rings` blob is exactly the payload `without rowid` penalizes.
 */
export async function createSoilMapUnitAreaTable(db: SoilSchemaHandle): Promise<void> {
	const table = db.schema
		.createTable("soil_map_unit_area")
		.addColumn("area_id", "text", (c) => c.primaryKey())
		.addColumn("mukey", "text", (c) => c.notNull())
		.addColumn("areasymbol", "text", (c) => c.notNull())

	await addRingGeometryColumns(table).execute()
}

/**
 * Create `soil_map_unit_cell`, the containment index.
 *
 * Small fixed-width rows probed by their exact primary key.
 */
export async function createSoilMapUnitCellTable(db: SoilSchemaHandle): Promise<void> {
	const table = db.schema.createTable("soil_map_unit_cell")

	await addCellIndexColumns(table, "area_id")
		.addPrimaryKeyConstraint("soil_map_unit_cell_pk", ["h3_cell", "area_id"])
		// `without rowid` has no first-class builder. The raw modifier is the idiomatic fallback.
		.modifyEnd(sql`without rowid`)
		.execute()
}

/**
 * Create `soil_map_unit`.
 */
export async function createSoilMapUnitTable(db: SoilSchemaHandle): Promise<void> {
	await db.schema
		.createTable("soil_map_unit")
		.addColumn("mukey", "text", (c) => c.primaryKey())
		.addColumn("areasymbol", "text", (c) => c.notNull())
		.addColumn("musym", "text", (c) => c.notNull())
		.addColumn("muname", "text", (c) => c.notNull())
		.addColumn("mukind", "text")
		.addColumn("mustatus", "text")
		.addColumn("farmlndcl", "text")
		.addColumn("farmland_scope", "text", (c) => c.notNull())
		.addColumn("niccdcd", "text")
		.addColumn("niccdcdpct", "integer")
		.addColumn("no_mapping", "integer", (c) => c.notNull())
		.execute()
}

/**
 * Create `soil_component`.
 */
export async function createSoilComponentTable(db: SoilSchemaHandle): Promise<void> {
	await db.schema
		.createTable("soil_component")
		.addColumn("cokey", "text", (c) => c.primaryKey())
		.addColumn("mukey", "text", (c) => c.notNull())
		.addColumn("comppct_r", "integer", (c) => c.notNull())
		.addColumn("compname", "text")
		.addColumn("compkind", "text")
		.addColumn("nirrcapcl", "text")
		.addColumn("nirrcapscl", "text")
		.addColumn("irrcapcl", "text")
		.addColumn("irrcapscl", "text")
		.addColumn("nccpi_v3", "real")
		.execute()
}

/**
 * Create `soil_capability_cell`.
 * The reduction both consumers read.
 */
export async function createSoilCapabilityCellTable(db: SoilSchemaHandle): Promise<void> {
	await db.schema
		.createTable("soil_capability_cell")
		.addColumn("h3_cell", "integer", (c) => c.primaryKey())
		.addColumn("class_shares", "text", (c) => c.notNull())
		.addColumn("unrated_share", "real", (c) => c.notNull())
		.addColumn("notrateable_share", "real", (c) => c.notNull())
		.addColumn("nodata_share", "real", (c) => c.notNull())
		.addColumn("other_share", "real", (c) => c.notNull())
		.addColumn("mapped_share", "real", (c) => c.notNull())
		.addColumn("top_class", "text")
		.addColumn("top_class_share", "real")
		.addColumn("weighting", "text", (c) => c.notNull())
		.addColumn("delineations", "integer", (c) => c.notNull())
		.modifyEnd(sql`without rowid`)
		.execute()
}

/**
 * Create `soil_survey_area`.
 */
export async function createSoilSurveyAreaTable(db: SoilSchemaHandle): Promise<void> {
	const table = db.schema
		.createTable("soil_survey_area")
		.addColumn("areasymbol", "text", (c) => c.primaryKey())
		.addColumn("areaname", "text", (c) => c.notNull())
		.addColumn("saverest", "text", (c) => c.notNull())
		.addColumn("saversion", "integer")
		.addColumn("survey_source_date", "text")
		.addColumn("survey_source_title", "text")
		.addColumn("source_scale", "integer")
		.addColumn("mapping_scale", "integer")
		.addColumn("area_acres", "integer")

	await addBoundingBoxColumns(table)
		.addColumn("coverage_cells", "integer", (c) => c.notNull())
		.addColumn("coverage_resolution", "integer", (c) => c.notNull())
		.execute()
}

/**
 * Create `soil_vocabulary`.
 */
export async function createSoilVocabularyTable(db: SoilSchemaHandle): Promise<void> {
	await db.schema
		.createTable("soil_vocabulary")
		.addColumn("domain", "text", (c) => c.notNull())
		.addColumn("code", "text", (c) => c.notNull())
		.addColumn("definition", "text", (c) => c.notNull())
		.addColumn("sequence", "integer", (c) => c.notNull())
		.addPrimaryKeyConstraint("soil_vocabulary_pk", ["domain", "code"])
		.modifyEnd(sql`without rowid`)
		.execute()
}

/**
 * Every domain table this layer owns, in dependency order.
 */
export async function createSoilTables(db: SoilSchemaHandle): Promise<void> {
	await createSoilMapUnitAreaTable(db)
	await createSoilMapUnitCellTable(db)
	await createSoilMapUnitTable(db)
	await createSoilComponentTable(db)
	await createSoilCapabilityCellTable(db)
	await createSoilSurveyAreaTable(db)
	await createSoilVocabularyTable(db)
}
