/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Reader for `coastal-england.db`, which reports the Environment Agency's coastal erosion zones at a
 *   coordinate under a named scenario.
 *
 *   A reading is `designated` when an erosion polygon of that scenario contains the point, and `unknown`
 *   otherwise. The source publishes no coverage statement, so an empty answer cannot mean "not at risk".
 *   A point with no polygon may be inland or on an unmapped coast. The constructor therefore refuses
 *   any coverage row whose basis would support an exclusion.
 *
 *   The layer describes the authority's map. The Environment Agency states that its data
 *   "cannot provide details for individual properties", and every reading carries the product limits.
 *
 *   A lookup walks the H3 ancestor chain first. Only a cell that a boundary crosses leads to a ray cast
 *   against the polygons indexed for that cell and scenario.
 */

import { stringifyJSON } from "@mailwoman/core/json"
import {
	assertCoverageLicensesNoExclusion,
	assertNoCellsFinerThanIndex,
	parseManifestRows,
	type CoverageCell,
	type LayerManifest,
} from "@mailwoman/core/layers"
import { CoverageBasis } from "@mailwoman/evidence"
import {
	ancestorChainCells,
	bboxContains,
	recoverShortCellResolution,
	shortCellToInt,
	type H3Cell,
	pointInEncodedRings,
} from "@mailwoman/spatial"
import { readCoverageAt } from "@mailwoman/spatial/h3/coverage"
import { DatabaseClient, type StatementSync } from "@mailwoman/sqlite/client"
import { latLngToCell } from "h3-js"
import type { PathBuilderLike } from "path-ts"

import type { CoastalDatabase } from "#schema"
import { CoastalCellContainment } from "#schema"
import {
	NCERM_COVERAGE_LIMIT,
	NCERM_LAYER_NAME,
	NCERM_PRODUCT_LIMITS,
	NCERM_SCENARIOS_BY_KEY,
	type CoastalScenario,
} from "#vocabulary"

export { DEFAULT_NCERM_SCENARIO, NCERM_SCENARIOS, NCERM_SCENARIOS_BY_KEY, type CoastalScenario } from "#vocabulary"

/**
 * Kinds of reading the layer returns for a coordinate under one scenario.
 */
export const CoastalReadingKind = {
	/**
	 * An erosion zone of the requested scenario contains the location.
	 */
	Designated: "designated",
	/**
	 * No erosion polygon of that scenario contains the point.
	 * This does not mean the location is safe.
	 */
	Unknown: "unknown",
} as const

/**
 * One of the {@link CoastalReadingKind} values.
 */
export type CoastalReadingKind = (typeof CoastalReadingKind)[keyof typeof CoastalReadingKind]

/**
 * How containment was established.
 */
export const CoastalContainmentPath = {
	/**
	 * The cell lies wholly inside the zone, so no geometry was read.
	 */
	WholeCell: "whole_cell",
	/**
	 * A boundary crosses the cell, so the point was ray-cast against that cell's polygons.
	 */
	RayCast: "ray_cast",
	/**
	 * No zone of this scenario reaches the cell.
	 */
	NoZoneCell: "no_zone_cell",
} as const

/**
 * One of the {@link CoastalContainmentPath} values.
 */
export type CoastalContainmentPath = (typeof CoastalContainmentPath)[keyof typeof CoastalContainmentPath]

/**
 * One erosion polygon the point falls inside, as the authority publishes it.
 */
export interface CoastalDesignation {
	areaID: string
	frontageID: number
	/**
	 * Cumulative erosion distance in metres, as published under this scenario.
	 */
	distanceM: number
	shorelineManagementPlan?: { number: number; name: string; policyUnit: string }
	/**
	 * The medium- and long-term policy with interpretations.
	 *
	 * The NFI scenarios assume no intervention, so they have no policy.
	 */
	policy?: {
		mediumTerm: string | null
		mediumTermInterpretation: string | null
		longTerm: string | null
		longTermInterpretation: string | null
	}
	defenceType?: string
	/**
	 * Publication year as published.
	 *
	 * Some source rows carry 0 with blank policy and defence fields, and the source does not explain them.
	 */
	publishedYear?: number
	/**
	 * How this polygon was reached.
	 */
	containment: CoastalContainmentPath
}

/**
 * One erosion reading, with the inputs a caller needs to check it.
 */
export interface CoastalErosionReading {
	kind: CoastalReadingKind
	/**
	 * The scenario the reading answers, present on every reading.
	 */
	scenario: CoastalScenario
	/**
	 * Every polygon of the scenario that contains the point, ordered by `area_id`.
	 *
	 * Overlapping frontages can yield several.
	 * The list is empty for an `unknown` reading.
	 */
	designations: CoastalDesignation[]
	/**
	 * How the reading was reached for the scenario as a whole.
	 */
	containment: CoastalContainmentPath
	/**
	 * The coverage row for the location's cell, when the product has data there.
	 *
	 * Its basis is always `source_present`, so neither its presence nor its
	 * absence shows the location is safe.
	 */
	coverage?: CoverageCell & { h3CellIndex: string; resolution: number }
	/**
	 * The H3 index cell that was probed.
	 */
	indexCellIndex: string
	/**
	 * What the product does not cover, in the authority's own words.
	 */
	limits: ReadonlyArray<string>
	/**
	 * One sentence that explains why the coverage cannot support a negative claim.
	 */
	coverageLimit: string
}

/**
 * One ground-instability polygon that contains a point.
 */
export interface CoastalGroundInstabilityReading {
	areaID: string
	kind: string
	location: string | null
	localAuthority: string | null
	shorelineManagementPlan?: { number: number; name: string; policyUnits: string | null }
	rearScarpProbability: string | null
}

/**
 * Layer metadata read once when the database opens.
 */
export interface CoastalLayerIdentity {
	manifest: LayerManifest
	indexResolution: number
	coverageResolution: number
	/**
	 * Every resolution with rows in `coastal_zone_cell`, coarsest first.
	 *
	 * Whole cells are compacted to coarser parents, and very large polygons are indexed
	 * coarser, so a lookup must probe every resolution in this list.
	 */
	cellResolutions: number[]
	/**
	 * Every scenario key in the layer's vocabulary table.
	 */
	scenarioKeys: string[]
	/**
	 * The authority's footprint statements.
	 *
	 * This edition has none, so coverage can only be `source_present`.
	 */
	mappedExtents: Array<{ extentID: string; source: string; statement: string; statementURL: string }>
	/**
	 * The coverage basis of every row, which the constructor checks is `source_present`.
	 */
	coverageBasis: CoverageBasis
	databasePath: string
}

/**
 * Options for {@link CoastalErosionLookup}.
 */
export interface CoastalErosionLookupOptions {
	databasePath: PathBuilderLike
}

interface AreaRow {
	area_id: string
	frontage_id: number
	distance_m: number
	smp_no: number | null
	smp_name: string | null
	smp_pu: string | null
	mt_policy: string | null
	mt_policy_interp: string | null
	lt_policy: string | null
	lt_policy_interp: string | null
	defence_type: string | null
	published_year: number | null
	min_lat: number
	min_lon: number
	max_lat: number
	max_lon: number
}

/**
 * Reader for a sealed `coastal-england.db`.
 *
 * The constructor throws on a manifest for another layer, a coverage basis that
 * would support an exclusion, or an empty scenario vocabulary.
 * Each of these would otherwise produce wrong answers.
 *
 * The reader is synchronous and uses raw prepared statements because each lookup
 * runs a bounded number of key probes.
 */
export class CoastalErosionLookup implements Disposable {
	readonly identity: CoastalLayerIdentity

	readonly #database: DatabaseClient<CoastalDatabase>
	readonly #selectCell: StatementSync
	readonly #selectArea: StatementSync
	readonly #selectAreaRings: StatementSync
	readonly #selectCoverage: StatementSync
	readonly #selectInstability: StatementSync
	readonly #selectInstabilityRings: StatementSync

	constructor(options: CoastalErosionLookupOptions) {
		this.#database = new DatabaseClient<CoastalDatabase>(options.databasePath, { readOnly: true })

		try {
			this.identity = readIdentity(this.#database, options.databasePath.toString())
		} catch (error) {
			this.#database.destroy()

			throw error
		}

		this.#selectCell = this.#database.prepare(
			"SELECT area_id, containment FROM coastal_zone_cell WHERE h3_cell = ? AND scenario_key = ?"
		)

		// The attributes and bbox are read apart from the geometry blob.
		// The bbox rejects most candidates before the large blob is read,
		// and a whole cell never reads the blob.
		this.#selectArea = this.#database.prepare(
			"SELECT area_id, frontage_id, distance_m, smp_no, smp_name, smp_pu, mt_policy, mt_policy_interp, lt_policy, " +
				"lt_policy_interp, defence_type, published_year, min_lat, min_lon, max_lat, max_lon " +
				"FROM coastal_zone_area WHERE area_id = ?"
		)

		this.#selectAreaRings = this.#database.prepare("SELECT rings FROM coastal_zone_area WHERE area_id = ?")

		this.#selectCoverage = this.#database.prepare(
			"SELECT h3_cell, completeness, basis, observed_rows FROM layer_coverage WHERE h3_cell = ?"
		)

		// The instability table is small, so a bbox table scan is cheap.
		// The blob is again read separately.
		this.#selectInstability = this.#database.prepare(
			"SELECT area_id, kind, location, local_authority, smp_no, smp_name, smp_policy_units, rear_scarp_probability " +
				"FROM coastal_ground_instability WHERE ? BETWEEN min_lon AND max_lon AND ? BETWEEN min_lat AND max_lat " +
				"ORDER BY area_id"
		)

		this.#selectInstabilityRings = this.#database.prepare(
			"SELECT rings FROM coastal_ground_instability WHERE area_id = ?"
		)
	}

	/**
	 * Return the erosion reading at a coordinate under one scenario.
	 *
	 * @throws {Error} When the layer does not hold `scenarioKey`.
	 * An empty reading would hide the typo.
	 */
	public lookup(latitude: number, longitude: number, scenarioKey: string): CoastalErosionReading {
		const scenario = NCERM_SCENARIOS_BY_KEY.get(scenarioKey)

		if (!scenario || !this.identity.scenarioKeys.includes(scenarioKey)) {
			throw new Error(
				`coastal reader: ${stringifyJSON(scenarioKey)} is not a scenario this layer holds (${this.identity.scenarioKeys.join(", ")}) — ` +
					"a scenario is part of the claim, so an unrecognized one is refused rather than answered as an absence"
			)
		}

		const indexCell = latLngToCell(latitude, longitude, this.identity.indexResolution) as H3Cell
		const coverage = this.#readCoverage(indexCell)
		const resolved = this.#resolveDesignations(indexCell, latitude, longitude, scenarioKey)

		return {
			kind: resolved.designations.length ? CoastalReadingKind.Designated : CoastalReadingKind.Unknown,
			scenario,
			designations: resolved.designations,
			containment: resolved.containment,
			...(coverage ? { coverage } : {}),
			indexCellIndex: indexCell,
			limits: NCERM_PRODUCT_LIMITS,
			coverageLimit: NCERM_COVERAGE_LIMIT,
		}
	}

	/**
	 * Return the ground-instability polygons that contain a coordinate.
	 *
	 * Ground instability is a separate hazard with its own schema, so erosion readings never include it.
	 */
	public groundInstabilityAt(latitude: number, longitude: number): CoastalGroundInstabilityReading[] {
		const candidates = this.#selectInstability.all(longitude, latitude) as Array<{
			area_id: string
			kind: string
			location: string | null
			local_authority: string | null
			smp_no: number | null
			smp_name: string | null
			smp_policy_units: string | null
			rear_scarp_probability: string | null
		}>

		const readings: CoastalGroundInstabilityReading[] = []

		for (const row of candidates) {
			const geometry = this.#selectInstabilityRings.get(row.area_id) as { rings: Uint8Array } | undefined

			if (!geometry || !pointInEncodedRings(geometry.rings, longitude, latitude)) continue

			readings.push({
				areaID: row.area_id,
				kind: row.kind,
				location: row.location,
				localAuthority: row.local_authority,
				...(row.smp_no === null || row.smp_name === null
					? {}
					: {
							shorelineManagementPlan: {
								number: row.smp_no,
								name: row.smp_name,
								policyUnits: row.smp_policy_units,
							},
						}),
				rearScarpProbability: row.rear_scarp_probability,
			})
		}

		return readings
	}

	public [Symbol.dispose]() {
		return this.#database.destroy()
	}

	/**
	 * Read the coverage row for the index cell's parent at the coverage resolution.
	 */
	#readCoverage(indexCell: H3Cell): (CoverageCell & { h3CellIndex: string; resolution: number }) | undefined {
		return readCoverageAt(this.#selectCoverage, indexCell, this.identity.coverageResolution)
	}

	/**
	 * Walk the cell index for one scenario, and ray-cast only the polygons of partial cells.
	 */
	#resolveDesignations(
		indexCell: H3Cell,
		latitude: number,
		longitude: number,
		scenarioKey: string
	): { designations: CoastalDesignation[]; containment: CoastalContainmentPath } {
		const whole = new Set<string>()
		const partial = new Set<string>()

		for (const cell of ancestorChainCells(indexCell, this.identity.indexResolution, this.identity.cellResolutions)) {
			const rows = this.#selectCell.all(shortCellToInt(cell), scenarioKey) as Array<{
				area_id: string
				containment: string
			}>

			for (const row of rows) {
				if (row.containment === CoastalCellContainment.Whole) {
					whole.add(row.area_id)
				} else {
					partial.add(row.area_id)
				}
			}
		}

		const designations: CoastalDesignation[] = []

		for (const areaID of [...whole].toSorted()) {
			const area = this.#selectArea.get(areaID) as AreaRow | undefined

			if (area) {
				designations.push(toDesignation(area, CoastalContainmentPath.WholeCell))
			}
		}

		let rayCastRan = false

		for (const areaID of [...partial].toSorted()) {
			// A polygon already found whole elsewhere in the chain needs no geometry read.
			if (whole.has(areaID)) continue

			const area = this.#selectArea.get(areaID) as AreaRow | undefined

			if (!area) continue

			rayCastRan = true

			if (!bboxContains(area, longitude, latitude)) {
				continue
			}

			const geometry = this.#selectAreaRings.get(areaID) as { rings: Uint8Array } | undefined

			if (!geometry) continue

			if (pointInEncodedRings(geometry.rings, longitude, latitude)) {
				designations.push(toDesignation(area, CoastalContainmentPath.RayCast))
			}
		}

		if (designations.length) {
			designations.sort((left, right) => (left.areaID < right.areaID ? -1 : 1))

			return {
				designations,
				containment: whole.size ? CoastalContainmentPath.WholeCell : CoastalContainmentPath.RayCast,
			}
		}

		return {
			designations,
			containment: rayCastRan ? CoastalContainmentPath.RayCast : CoastalContainmentPath.NoZoneCell,
		}
	}
}

/**
 * Convert a stored area row to a designation.
 */
function toDesignation(area: AreaRow, containment: CoastalContainmentPath): CoastalDesignation {
	return {
		areaID: area.area_id,
		frontageID: area.frontage_id,
		distanceM: area.distance_m,
		...(area.smp_no === null || area.smp_name === null
			? {}
			: {
					shorelineManagementPlan: { number: area.smp_no, name: area.smp_name, policyUnit: area.smp_pu ?? "" },
				}),
		// NFI rows have no policy, so the policy object is omitted when both policy fields are null.
		...(area.mt_policy === null && area.lt_policy === null
			? {}
			: {
					policy: {
						mediumTerm: area.mt_policy,
						mediumTermInterpretation: area.mt_policy_interp,
						longTerm: area.lt_policy,
						longTermInterpretation: area.lt_policy_interp,
					},
				}),
		...(area.defence_type === null ? {} : { defenceType: area.defence_type }),
		...(area.published_year === null ? {} : { publishedYear: area.published_year }),
		containment,
	}
}

/**
 * Read and check the layer's identity.
 */
function readIdentity(database: DatabaseClient<CoastalDatabase>, databasePath: string): CoastalLayerIdentity {
	const manifestRows = database.prepare("SELECT * FROM layer_manifest").all() as Array<
		Record<string, string | number | null>
	>

	const manifest = parseManifestRows(manifestRows, NCERM_LAYER_NAME, `coastal reader: ${databasePath}`)
	const spineKeys = manifest.spineKeys

	if (!spineKeys.h3) {
		throw new Error(`coastal reader: ${databasePath} declares no h3 spine key`)
	}

	// NCERM publishes no coverage statement, so no coverage row may support a claim that a location is safe.
	assertCoverageLicensesNoExclusion(
		(database.prepare("SELECT DISTINCT basis FROM layer_coverage").all() as Array<{ basis: string | null }>).map(
			(coverageRow) => coverageRow.basis
		),
		`coastal reader: ${databasePath}`,
		NCERM_COVERAGE_LIMIT
	)

	const extentRows = database.prepare("SELECT * FROM coastal_mapped_extent ORDER BY extent_id").all() as Array<
		Record<string, string | number>
	>

	const cellResolutions = (
		database.prepare("SELECT DISTINCT resolution FROM coastal_zone_cell ORDER BY resolution").all() as Array<{
			resolution: number
		}>
	).map((r) => r.resolution)

	const indexResolution = spineKeys.h3.resolution

	assertNoCellsFinerThanIndex(cellResolutions, indexResolution, `coastal reader: ${databasePath}`)

	const scenarioKeys = (
		database
			.prepare("SELECT value FROM coastal_scenario_vocabulary WHERE field = 'scenario_key' ORDER BY value")
			.all() as Array<{ value: string }>
	).map((r) => r.value)

	if (!scenarioKeys.length) {
		throw new Error(
			`coastal reader: ${databasePath} declares no scenario vocabulary — a probe could not name the scenario it answered under`
		)
	}

	// The manifest records only the index resolution, and this layer has no footprint
	// row that could record the coarser coverage resolution.
	// A short cell is valid at exactly one resolution, so the helper recovers it from
	// the cells and throws if the table mixes resolutions.
	const coverageResolution = recoverShortCellResolution(
		(database.prepare("SELECT h3_cell FROM layer_coverage").all() as Array<{ h3_cell: number }>).map(
			(coverageRow) => coverageRow.h3_cell
		),
		`coastal reader: ${databasePath}`
	)

	return {
		manifest,
		indexResolution,
		coverageResolution,
		cellResolutions,
		scenarioKeys,
		mappedExtents: extentRows.map((extentRow) => ({
			extentID: String(extentRow.extent_id),
			source: String(extentRow.source),
			statement: String(extentRow.statement),
			statementURL: String(extentRow.statement_url),
		})),
		coverageBasis: CoverageBasis.SourcePresent,
		databasePath,
	}
}
