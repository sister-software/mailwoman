/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Typed schema for `soil.db`, the polygon truth table, the containment index above it, and the one
 *   reduction both consumers read, plus the layer-interface tables from `@mailwoman/core/layers`.
 *
 *   {@link SoilMapUnitAreaTable} is what the authority drew, unsimplified.
 *   {@link SoilMapUnitCellTable} says which cells each delineation reaches and whether it fills them.
 *   {@link SoilCapabilityCellTable} is that index reduced once, at build time, into a per-cell
 *   distribution. A `partial` cell's contribution is weighted by the area it covers, so the truth
 *   table keeps unsimplified rings and simplification would change the weights silently.
 *
 *   The reduction stores a distribution rather than a winner. Four separate shares record the
 *   absence reasons, and class 8 is a determination rather than an absence, so it is a class share
 *   like any other. Folding a `notcom` polygon, a water body and an unrated series into "not arable"
 *   would produce a well-formed wrong answer, and the four shares exist to prevent that.
 *
 *   `without rowid` applies to the cell tables, while the geometry table stays a plain rowid table.
 *   Small fixed-width rows probed by their exact primary key belong in the B-tree, while a row
 *   carrying a geometry blob does not, since clustering it into the B-tree makes every index page a
 *   geometry page.
 */

import type { layerschemadatabase } from "@mailwoman/core/layers"
import { addBoundingBoxColumns, addCellIndexColumns, addRingGeometryColumns } from "@mailwoman/sqlite/schema-columns"
import { sql, type Kysely } from "kysely"

/**
 * Whether an H3 cell lies wholly inside one map-unit delineation, or is crossed by its boundary.
 */
export const SoilCellContainment = {
	/**
	 * Every point in the cell is inside the delineation.
	 *
	 * Answered from the index alone, with no geometry read.
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
 * A plain rowid table, because a geometry blob is the one shape `without rowid` hurts.
 */
export interface SoilMapUnitAreaTable {
	/**
	 * `<areasymbol>:<ordinal>`, the survey area plus this delineation's position
	 * in the authority's own shapefile order.
	 *
	 * Ssurgo publishes no per-delineation key of its own.
	 * `mukey` identifies the MAP unit, and one map unit has many delineations,
	 * so the ordinal is what makes a row nameable at all.
	 *
	 * Text, so a source that starts publishing a non-numeric id needs no schema change.
	 */
	area_id: string
	/**
	 * The map unit this delineation belongs to, nrcs's own key and the join to every attribute.
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
 * Per (cell, delineation): does the delineation cover the whole cell, or only part of it?
 *
 * Keyed on the delineation rather than on the map unit, because the reduction weights by the area a
 * delineation covers and two delineations of one map unit reaching the same cell cover different ground.
 */
export interface SoilMapUnitCellTable {
	/**
	 * 48-bit short H3 cell.
	 *
	 * Mixed-resolution: `whole` rows are compacted parent-ward, `partial` rows stay at the index resolution.
	 */
	h3_cell: number
	/**
	 * The resolution this row's cell was captured at.
	 *
	 * A short cell carries no resolution of its own, and a table that mixes
	 * resolutions cannot be probed without this column.
	 */
	resolution: number
	area_id: string
	/**
	 * One of {@link SoilCellContainment}.
	 */
	containment: string
}

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
	 * unit carries no farmland classification at all.
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
	 * Nrcs's own dominant-condition capability class for the map unit, carried rather than recomputed.
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
	 * It is carried but never reduced.
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
	 * The five shares above are normalized over this, so they sum to 1 exactly.
	 * A cell at the edge of a survey area is partly outside every delineation, and without
	 * this column that unmapped remainder would silently deflate every class share.
	 *
	 * An absence represented as a small number, which is the one thing this schema exists to prevent.
	 * A cell wholly inside the mapped area reads 1.
	 */
	mapped_share: number
	/**
	 * The largest class share and the share it rests on, the result-level consumer's reading
	 * and nrcs's own `niccdcd`/`niccdcdpct` pattern at cell grain.
	 *
	 * NULL when the cell carries no class at all, which is a real answer.
	 * A cell that is 100% `unrated_share` is complete and carries no capability reading at all.
	 */
	top_class: string | null
	top_class_share: number | null
	/**
	 * Which weighting produced the shares, one of {@link SOIL_SHARE_WEIGHTING}.
	 *
	 * Stored per row rather than only in the manifest, because a later build at a
	 * different weighting must not read as the same claim.
	 */
	weighting: string
	/**
	 * How many delineations reached this cell.
	 *
	 * The denominator behind every share above, and the number that separates a
	 * confident single-delineation cell from a crowded one.
	 */
	delineations: number
}

/**
 * The authority's mapped footprint, one row per published survey area, derived from the
 * survey-area outline and each area's own metadata rather than from the rated polygons.
 *
 * Deriving it from the rated polygons is the error §3.2 of the survey describes.
 * `notcom` and access-denied map units are inside the footprint and carry no rating,
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
	 * This is a different fact from `saverest` and keeping them apart is the point.
	 * `IA153` carries a 2025-09-09 refresh over a field survey published in 1960,
	 * and the dataset's own time-period-of-content ends at the refresh, so a consumer
	 * reading that as survey currency reads it wrong.
	 */
	survey_source_date: string | null
	/**
	 * The title of the source `survey_source_date` came from, so the date is checkable rather than assertible.
	 */
	survey_source_title: string | null
	/**
	 * The scale of that original source, 15840 for `IA153`'s 1960 survey.
	 */
	source_scale: number | null
	/**
	 * The scale the map units were digitized at, from `legend.projectscale`, 12000 for `IA153`.
	 *
	 * A different number from `source_scale` and a different fact: one is how finely
	 * the ground was walked, the other how finely it was drawn.
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
	 * How many `layer_coverage` rows this survey area produced, and at what resolution.
	 */
	coverage_cells: number
	coverage_resolution: number
}

/**
 * The authority's declared domain for one `Choice` column, read out of the `msdomdet.txt` the archive ships.
 *
 * Stored so a reader can refuse a code the layer was never built to hold, and
 * so the authority's own prose definition of "capability class 3" travels with the artifact
 * instead of living in a handbook the reader has to go find.
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
	 * Ordering within the domain, as the authority declares it.
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
