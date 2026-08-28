/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The `flood.db` reader — what the authority's map assigns at a coordinate, and on what basis.
 *
 *   THREE ANSWERS, AND KEEPING THEM APART IS THE WHOLE JOB.
 *
 *   1. `designated` — the authority's map assigns a zone here, and the zone code is the answer.
 *   2. `designated_absence` — the authority determined here and assigns NO zone. Inside England that is
 *      Zone 1 by the Planning Practice Guidance's own definition ("all land outside Zones 2, 3a and 3b"),
 *      which is why an empty answer inside the footprint is a designation rather than a gap.
 *   3. `unknown` — no coverage row for this location. The EA's statement covers England and says nothing
 *      about Wales, Scotland or Northern Ireland, each of which has a different authority and a different
 *      zone scheme; the England border strip is unknown too, because the footprint's interior test drops
 *      any cell not wholly inside the outline.
 *
 *   READINGS 2 AND 3 ARE THE SAME EMPTY ANSWER FROM THE GEOMETRY AND OPPOSITE ANSWERS FROM THE READER.
 *   A layer that could not tell them apart would report every unmapped location as low-hazard, which is
 *   the failure this whole program exists to prevent.
 *
 *   NEITHER READING IS A STATEMENT ABOUT A PROPERTY. The layer reports which zone the authority's map
 *   assigns at a location, which is a fact about the map. The EA states that its data is "not suitable for
 *   showing whether an individual property is at risk of flooding", and this reader never claims otherwise
 *   — `limits` carries the authority's own exclusions on every answer.
 *
 *   THE PROBE IS STRUCTURE FIRST, GEOMETRY LAST. `cellToParent` up the compacted whole-cell chain answers
 *   an interior point with primary-key probes alone; only a cell the boundary crosses reaches the ray
 *   cast, and then only against the polygons `flood_zone_cell_area` already named for that cell. That is
 *   SCOPE invariant 6's division: containment precomputed at build time, spatial math kept to the
 *   irreducibly geometric edge.
 *
 *   THE READER IS SYNCHRONOUS AND USES RAW PREPARED STATEMENTS. It answers one point per geocode with up
 *   to `indexResolution - coverageResolution` primary-key probes plus a bounded geometry read, and the
 *   ray cast it wraps is synchronous anyway. Kysely's builder is async, so an async reader would put a
 *   promise between the coordinate and the point test for no query the builder expresses better. The DDL
 *   that created these tables IS Kysely — see `schema.ts`.
 */

import { DatabaseSync } from "node:sqlite"

import {
	parseManifestRows,
	toCoverageCell,
	type CoverageRow,
	type CoverageCell,
	type LayerManifest,
} from "@mailwoman/core/layers"
import { shortCellToInt, type H3Cell } from "@mailwoman/spatial"
import { cellToParent, latLngToCell } from "h3-js"

import { pointInEncodedRings } from "./rings.ts"
import { FloodCellContainment } from "./schema.ts"
import { EA_FLOOD_LAYER_NAME, EA_PRODUCT_LIMITS, FLOOD_ZONE_1, type FloodZoneDefinition } from "./vocabulary.ts"

export { FLOOD_ZONE_1, type FloodZoneDefinition } from "./vocabulary.ts"

/**
 * What the layer can say about a coordinate.
 */
export const FloodReadingKind = {
	/**
	 * The authority's map assigns a zone at this location.
	 */
	Designated: "designated",
	/**
	 * The authority determined here and assigns no zone — a designated absence, which for this product is Zone 1.
	 */
	DesignatedAbsence: "designated_absence",
	/**
	 * No coverage row. Unmapped by this authority, and never a low-hazard reading.
	 */
	Unknown: "unknown",
} as const

export type FloodReadingKind = (typeof FloodReadingKind)[keyof typeof FloodReadingKind]

/**
 * How the zone at a location was established.
 */
export const FloodContainmentPath = {
	/**
	 * The cell lies wholly inside the zone; no geometry was read.
	 */
	WholeCell: "whole_cell",
	/**
	 * The cell is crossed by a boundary; the point was ray-cast against a named polygon.
	 */
	RayCast: "ray_cast",
	/**
	 * No zone reaches this cell at all.
	 */
	NoZoneCell: "no_zone_cell",
} as const

export type FloodContainmentPath = (typeof FloodContainmentPath)[keyof typeof FloodContainmentPath]

/**
 * One reading, carrying everything a caller needs to re-derive it rather than take it.
 */
export interface FloodZoneReading {
	kind: FloodReadingKind
	/**
	 * The authority's zone code, verbatim. Present on a `designated` reading; absent on the other two.
	 */
	zoneCode?: string
	/**
	 * The definition the authority publishes for the answered zone — {@link FLOOD_ZONE_1} on a designated absence, since
	 * this product represents Zone 1 by absence and ships no polygon for it.
	 */
	definition?: FloodZoneDefinition
	/**
	 * The polygon the ray cast matched, on a `ray_cast` reading. Named so a reader can fetch and draw it.
	 */
	areaID?: string
	/**
	 * How the answer was reached.
	 */
	containment: FloodContainmentPath
	/**
	 * The coverage row that licenses the reading, when there is one. Absent on `unknown`, which IS the absence.
	 */
	coverage?: CoverageCell & { h3CellIndex: string; resolution: number }
	/**
	 * The index cell probed, for a receipt.
	 */
	indexCellIndex: string
	/**
	 * What the product does not cover, in the authority's own words. Carried on every reading, because a Zone 1 answer is
	 * silent about surface water, groundwater and defended-area residual risk, and a caller cannot see that from the zone
	 * code.
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
	 * Every resolution `flood_zone_cell` stores a row at, coarsest first — the ancestor chain a probe walks.
	 *
	 * Several, and necessarily so: the whole tier is compacted parent-ward, and a polygon too large for h3's allocator at
	 * the index resolution was indexed coarser. A reader that probed one resolution would read every row at the others as
	 * an absence.
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
	databasePath: string
}

/**
 * Read a sealed `flood.db`.
 *
 * Everything that would make the reader answer a well-formed wrong thing is refused at CONSTRUCTION rather than at
 * query time: a manifest naming a different layer, a coverage table with no rows, an extent row that is missing or
 * duplicated. Each of those would otherwise present as a reader that simply always answers `unknown`, which on a
 * receipt is indistinguishable from a region the authority genuinely has not mapped.
 */
export class FloodZoneLookup {
	readonly identity: FloodLayerIdentity

	readonly #database: DatabaseSync
	readonly #selectCell: ReturnType<DatabaseSync["prepare"]>
	readonly #selectCandidates: ReturnType<DatabaseSync["prepare"]>
	readonly #selectAreaBounds: ReturnType<DatabaseSync["prepare"]>
	readonly #selectAreaRings: ReturnType<DatabaseSync["prepare"]>
	readonly #selectCoverage: ReturnType<DatabaseSync["prepare"]>
	readonly #definitions: Map<string, FloodZoneDefinition>

	constructor(options: FloodZoneLookupOptions) {
		this.#database = new DatabaseSync(options.databasePath, { readOnly: true })

		try {
			this.identity = readIdentity(this.#database, options.databasePath)
			this.#definitions = readDefinitions(this.#database)
		} catch (error) {
			this.#database.close()

			throw error
		}

		this.#selectCell = this.#database.prepare("SELECT zone_code, containment FROM flood_zone_cell WHERE h3_cell = ?")

		this.#selectCandidates = this.#database.prepare(
			"SELECT area_id FROM flood_zone_cell_area WHERE h3_cell = ? ORDER BY area_id"
		)

		// TWO STATEMENTS, AND THE SPLIT IS THE POINT. The bbox is the prefilter, so it is read WITHOUT the blob: the
		// largest features in this product carry hundreds of thousands of vertices, and pulling one off disk only to
		// reject it on a rectangle would make the prefilter cost more than the test it replaces.
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

		// COVERAGE QUALIFIES THE ABSENCE AND NOTHING ELSE — the same asymmetry `supportsExclusion` carries. A polygon
		// containing the point IS the authority's determination at that location, and needs no coverage row to be true;
		// an EMPTY answer needs one, because without it the emptiness is a statement about our map rather than theirs.
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

	public close(): void {
		this.#database.close()
	}

	/**
	 * The coverage row for the index cell's parent at the coverage resolution.
	 */
	#readCoverage(indexCell: H3Cell): (CoverageCell & { h3CellIndex: string; resolution: number }) | undefined {
		const coverageCell = cellToParent(indexCell, this.identity.coverageResolution) as H3Cell

		// The NULL-basis rule lives in the shared mapping: a NULL column is an artifact built before `basis` existed, and
		// it was recording source presence — never a stronger basis than the builder actually had.
		return toCoverageCell(
			this.#selectCoverage.get(shortCellToInt(coverageCell)) as CoverageRow | undefined,
			coverageCell,
			this.identity.coverageResolution
		)
	}

	/**
	 * Walk the index, falling through to the geometry only for a cell a boundary crosses.
	 */
	#resolveZone(
		indexCell: H3Cell,
		latitude: number,
		longitude: number
	): { zoneCode?: string; areaID?: string; containment: FloodContainmentPath } {
		// The stored rows sit at SEVERAL resolutions: the whole tier is compacted parent-ward, and a polygon whose bounding
		// box would not fit h3's allocator at the index resolution was indexed coarser (see `sdk/cells.ts`). So a point is
		// answered by walking its own ancestor chain over every resolution the layer stores. Coarsest first: a whole hit
		// high in the chain is the cheapest answer and cannot be contradicted lower down, because compaction only ever
		// replaces a full set of children with their parent.
		const partialCells: number[] = []

		for (const resolution of this.identity.cellResolutions) {
			const cell =
				resolution === this.identity.indexResolution ? indexCell : (cellToParent(indexCell, resolution) as H3Cell)

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

			// The bbox is the prefilter the geometry table stores precisely so the ray cast runs on the few polygons that
			// could contain the point rather than on every polygon reaching the cell.
			if (longitude < area.min_lon || longitude > area.max_lon || latitude < area.min_lat || latitude > area.max_lat) {
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
function readIdentity(database: DatabaseSync, databasePath: string): FloodLayerIdentity {
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

	if (!coverageCount) {
		throw new Error(
			`flood reader: ${databasePath} holds no coverage rows — every location would read as unknown, which is indistinguishable from a region the authority has not mapped`
		)
	}

	const cellResolutions = (
		database.prepare("SELECT DISTINCT resolution FROM flood_zone_cell ORDER BY resolution").all() as Array<{
			resolution: number
		}>
	).map((r) => r.resolution)

	const indexResolution = spineKeys.h3.resolution
	const finerThanIndex = cellResolutions.filter((resolution) => resolution > indexResolution)

	// A stored cell finer than the manifest's declared index resolution has no ancestor chain from the probe's own cell,
	// so `cellToParent` would throw mid-query on some coordinates and not others. Refused here instead: it means the
	// manifest and the rows disagree about what the layer is, which is a build defect rather than a runtime condition.
	if (finerThanIndex.length) {
		throw new Error(
			`flood reader: ${databasePath} stores cells at resolution(s) ${finerThanIndex.join(", ")}, finer than the manifest's declared index resolution ${indexResolution} — the manifest and the rows disagree`
		)
	}

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
function readDefinitions(database: DatabaseSync): Map<string, FloodZoneDefinition> {
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
