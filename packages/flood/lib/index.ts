/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The `flood.db` reader: a designated absence and an unmapped location are the same empty geometry and
 *   opposite answers, so neither is ever a low-hazard reading. The reader is synchronous and uses raw
 *   prepared statements because Kysely's builder is async and would put a promise between the coordinate
 *   and the point test.
 */

import {
	assertCoverageNotEmpty,
	assertNoCellsFinerThanIndex,
	parseManifestRows,
	type CoverageCell,
	type LayerManifest,
} from "@mailwoman/core/layers"
import { ancestorChainCells, bboxContains, shortCellToInt, type H3Cell, pointInEncodedRings } from "@mailwoman/spatial"
import { readCoverageAt } from "@mailwoman/spatial/h3/coverage"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { latLngToCell } from "h3-js"
import type { PathBuilderLike } from "path-ts"

import type { FloodDatabase } from "#schema"
import { FloodCellContainment } from "#schema"
import { EA_FLOOD_LAYER_NAME, EA_PRODUCT_LIMITS, FLOOD_ZONE_1, type FloodZoneDefinition } from "#vocabulary"

export { FLOOD_ZONE_1, type FloodZoneDefinition } from "#vocabulary"

/**
 * What the layer can say about a coordinate.
 */
export const FloodReadingKind = {
	Designated: "designated",
	/**
	 * The authority determined here and assigns no zone, represented as Zone 1 by this product.
	 */
	DesignatedAbsence: "designated_absence",
	Unknown: "unknown",
} as const

export type FloodReadingKind = (typeof FloodReadingKind)[keyof typeof FloodReadingKind]

/**
 * How the zone at a location was established.
 */
export const FloodContainmentPath = {
	/**
	 * The cell lies wholly inside the zone, so no geometry was read.
	 */
	WholeCell: "whole_cell",
	/**
	 * A boundary crosses the cell, so the point was ray-cast against a named polygon.
	 */
	RayCast: "ray_cast",
	NoZoneCell: "no_zone_cell",
} as const

export type FloodContainmentPath = (typeof FloodContainmentPath)[keyof typeof FloodContainmentPath]

/**
 * One reading, carrying everything a caller needs to re-derive it rather than take it.
 */
export interface FloodZoneReading {
	kind: FloodReadingKind
	/**
	 * The authority's zone code, verbatim, present only on a `designated` reading.
	 */
	zoneCode?: string
	/**
	 * The definition the authority publishes for the answered zone, {@link FLOOD_ZONE_1} on a
	 * designated absence, since this product represents Zone 1 by absence and ships no polygon for it.
	 */
	definition?: FloodZoneDefinition
	/**
	 * The polygon the ray cast matched on a `ray_cast` reading, named so a reader can fetch and draw it.
	 */
	areaID?: string
	containment: FloodContainmentPath
	/**
	 * The coverage row that licenses the reading, absent on `unknown`, which is the absence.
	 */
	coverage?: CoverageCell & { h3CellIndex: string; resolution: number }
	/**
	 * The index cell probed, for a receipt.
	 */
	indexCellIndex: string
	/**
	 * What the product does not cover, in the authority's own words, carried on every reading
	 * because a Zone 1 answer is silent about surface water, groundwater and defended-area residual risk.
	 */
	limits: ReadonlyArray<string>
}

/**
 * The layer's identity, read once at open time.
 */
export interface FloodLayerIdentity {
	manifest: LayerManifest
	indexResolution: number
	coverageResolution: number
	/**
	 * Every resolution `flood_zone_cell` stores a row at, coarsest first, because the whole tier
	 * is compacted parent-ward and a reader probing one resolution would read the others as an absence.
	 */
	cellResolutions: number[]
	/**
	 * The authority's footprint statement.
	 */
	extent: {
		extentID: string
		status: string
		authority: string
		statement: string
		statementURL: string
		boundarySource: string
		boundarySourceURL: string
		boundaryVintage: string
		boundaryLicense: string
		coverageCells: number
	}
	/**
	 * Every zone code the layer holds, from its own vocabulary table.
	 */
	zoneCodes: string[]
	databasePath: string
}

export interface FloodZoneLookupOptions {
	databasePath: PathBuilderLike
}

/**
 * Read a sealed `flood.db`, refusing at construction every condition that would
 * otherwise present as a reader that always answers `unknown`.
 */
export class FloodZoneLookup implements Disposable {
	readonly identity: FloodLayerIdentity

	readonly #database: DatabaseClient<FloodDatabase>
	readonly #selectCell: ReturnType<DatabaseClient["prepare"]>
	readonly #selectCandidates: ReturnType<DatabaseClient["prepare"]>
	readonly #selectAreaBounds: ReturnType<DatabaseClient["prepare"]>
	readonly #selectAreaRings: ReturnType<DatabaseClient["prepare"]>
	readonly #selectCoverage: ReturnType<DatabaseClient["prepare"]>
	readonly #definitions: Map<string, FloodZoneDefinition>

	constructor(options: FloodZoneLookupOptions) {
		this.#database = new DatabaseClient<FloodDatabase>(options.databasePath, { readOnly: true })

		try {
			this.identity = readIdentity(this.#database, options.databasePath.toString())
			this.#definitions = readDefinitions(this.#database)
		} catch (error) {
			this.#database.destroy()

			throw error
		}

		this.#selectCell = this.#database.prepare("SELECT zone_code, containment FROM flood_zone_cell WHERE h3_cell = ?")

		this.#selectCandidates = this.#database.prepare(
			"SELECT area_id FROM flood_zone_cell_area WHERE h3_cell = ? ORDER BY area_id"
		)

		// The bbox is read without the blob, so the prefilter never pulls a hundred-thousand-vertex
		// polygon off disk only to reject it on a rectangle.
		this.#selectAreaBounds = this.#database.prepare(
			"SELECT zone_code, min_lat, min_lon, max_lat, max_lon FROM flood_zone_area WHERE area_id = ?"
		)

		this.#selectAreaRings = this.#database.prepare("SELECT rings FROM flood_zone_area WHERE area_id = ?")

		this.#selectCoverage = this.#database.prepare(
			"SELECT h3_cell, completeness, basis, observed_rows FROM layer_coverage WHERE h3_cell = ?"
		)
	}

	/**
	 * What the authority's map assigns at this coordinate.
	 */
	public lookup(latitude: number, longitude: number): FloodZoneReading {
		const indexCell = latLngToCell(latitude, longitude, this.identity.indexResolution) as H3Cell
		const coverage = this.#readCoverage(indexCell)
		const zone = this.#resolveZone(indexCell, latitude, longitude)

		// Coverage qualifies the absence and no more: a polygon containing the point is the
		// authority's determination and needs no coverage row, while an empty answer does,
		// or it is a statement about our map rather than theirs.
		if (zone.zoneCode) {
			const definition = this.#definitions.get(zone.zoneCode)

			return {
				kind: FloodReadingKind.Designated,
				zoneCode: zone.zoneCode,
				...(definition ? { definition } : {}),
				...(zone.areaID ? { areaID: zone.areaID } : {}),
				containment: zone.containment,
				...(coverage ? { coverage } : {}),
				indexCellIndex: indexCell,
				limits: EA_PRODUCT_LIMITS,
			}
		}

		if (!coverage) {
			return {
				kind: FloodReadingKind.Unknown,
				containment: zone.containment,
				indexCellIndex: indexCell,
				limits: EA_PRODUCT_LIMITS,
			}
		}

		return {
			kind: FloodReadingKind.DesignatedAbsence,
			definition: FLOOD_ZONE_1,
			containment: zone.containment,
			coverage,
			indexCellIndex: indexCell,
			limits: EA_PRODUCT_LIMITS,
		}
	}

	public [Symbol.dispose](): void {
		this.#database.destroy()
	}

	/**
	 * The coverage row for the index cell's parent at the coverage resolution.
	 */
	#readCoverage(indexCell: H3Cell): (CoverageCell & { h3CellIndex: string; resolution: number }) | undefined {
		return readCoverageAt(this.#selectCoverage, indexCell, this.identity.coverageResolution)
	}

	/**
	 * Walk the index, falling through to the geometry only for a cell a boundary crosses.
	 */
	#resolveZone(
		indexCell: H3Cell,
		latitude: number,
		longitude: number
	): { zoneCode?: string; areaID?: string; containment: FloodContainmentPath } {
		// Coarsest first: a whole hit high in the ancestor chain cannot be contradicted lower down,
		// because compaction only ever replaces a full set of children with their parent.
		const partialCells: number[] = []

		for (const cell of ancestorChainCells(indexCell, this.identity.indexResolution, this.identity.cellResolutions)) {
			const short = shortCellToInt(cell)
			const rows = this.#selectCell.all(short) as Array<{ zone_code: string; containment: string }>

			const whole = rows.find((row) => row.containment === FloodCellContainment.Whole)

			if (whole) return { zoneCode: whole.zone_code, containment: FloodContainmentPath.WholeCell }

			if (rows.some((row) => row.containment === FloodCellContainment.Partial)) {
				partialCells.push(short)
			}
		}

		if (!partialCells.length) {
			return { containment: FloodContainmentPath.NoZoneCell }
		}

		const candidates = partialCells.flatMap((short) => this.#selectCandidates.all(short) as Array<{ area_id: string }>)

		for (const { area_id: areaID } of candidates) {
			const area = this.#selectAreaBounds.get(areaID) as
				| { zone_code: string; min_lat: number; min_lon: number; max_lat: number; max_lon: number }
				| undefined

			if (!area) continue

			// The bbox is the prefilter the geometry table stores precisely so the ray cast runs on the
			// few polygons that could contain the point rather than on every polygon reaching the cell.
			if (!bboxContains(area, longitude, latitude)) {
				continue
			}

			const geometry = this.#selectAreaRings.get(areaID) as { rings: Uint8Array } | undefined

			if (!geometry) continue

			if (pointInEncodedRings(geometry.rings, longitude, latitude)) {
				return { zoneCode: area.zone_code, areaID, containment: FloodContainmentPath.RayCast }
			}
		}

		return { containment: FloodContainmentPath.RayCast }
	}
}

/**
 * Read and check the layer's identity.
 */
function readIdentity(database: DatabaseClient<FloodDatabase>, databasePath: string): FloodLayerIdentity {
	const manifestRows = database.prepare("SELECT * FROM layer_manifest").all() as Array<
		Record<string, string | number | null>
	>

	const manifest = parseManifestRows(manifestRows, EA_FLOOD_LAYER_NAME, `flood reader: ${databasePath}`)
	const spineKeys = manifest.spineKeys

	if (!spineKeys.h3) {
		throw new Error(`flood reader: ${databasePath} declares no h3 spine key`)
	}

	const extentRows = database.prepare("SELECT * FROM flood_map_extent").all() as Array<Record<string, string | number>>

	if (extentRows.length !== 1) {
		throw new Error(
			`flood reader: ${databasePath} carries ${extentRows.length} extent rows, expected 1 — the footprint is the claim, and two of them is two claims`
		)
	}

	const extentRow = extentRows[0]!

	const coverageCount = (database.prepare("SELECT count(*) AS n FROM layer_coverage").get() as { n: number }).n

	assertCoverageNotEmpty(coverageCount, `flood reader: ${databasePath}`, "a region the authority has not mapped")

	const cellResolutions = (
		database.prepare("SELECT DISTINCT resolution FROM flood_zone_cell ORDER BY resolution").all() as Array<{
			resolution: number
		}>
	).map((r) => r.resolution)

	const indexResolution = spineKeys.h3.resolution

	assertNoCellsFinerThanIndex(cellResolutions, indexResolution, `flood reader: ${databasePath}`)

	const zoneCodes = (
		database.prepare("SELECT zone_code FROM flood_zone_vocabulary ORDER BY zone_code").all() as Array<{
			zone_code: string
		}>
	).map((r) => r.zone_code)

	if (!zoneCodes.length) {
		throw new Error(`flood reader: ${databasePath} declares no zone vocabulary — an answer could not be checked`)
	}

	return {
		manifest,
		indexResolution,
		coverageResolution: Number(extentRow.coverage_resolution),
		cellResolutions,
		extent: {
			extentID: String(extentRow.extent_id),
			status: String(extentRow.status),
			authority: String(extentRow.authority),
			statement: String(extentRow.statement),
			statementURL: String(extentRow.statement_url),
			boundarySource: String(extentRow.boundary_source),
			boundarySourceURL: String(extentRow.boundary_source_url),
			boundaryVintage: String(extentRow.boundary_vintage),
			boundaryLicense: String(extentRow.boundary_license),
			coverageCells: Number(extentRow.coverage_cells),
		},
		zoneCodes,
		databasePath,
	}
}

/**
 * The authority's zone definitions, keyed by code.
 */
function readDefinitions(database: DatabaseClient<FloodDatabase>): Map<string, FloodZoneDefinition> {
	const rows = database.prepare("SELECT * FROM flood_zone_vocabulary").all() as Array<{
		zone_code: string
		label: string
		definition: string
		definition_url: string
	}>

	return new Map(
		rows.map((row) => [
			row.zone_code,
			{ code: row.zone_code, label: row.label, definition: row.definition, definitionURL: row.definition_url },
		])
	)
}
