/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The `coastal-england.db` reader — what the Environment Agency's erosion mapping assigns at a coordinate,
 *   under a named scenario, and on what basis.
 *
 *   TWO READINGS, AND THE ONE THAT IS MISSING IS THE POINT.
 *
 *   1. `designated` — the authority's map places the location inside an erosion zone under the scenario
 *      asked for, and the polygon (its distance, its shoreline-management policy, its defence type) is the
 *      answer.
 *   2. `unknown` — no polygon of that scenario contains the point. THAT IS NOT AN ABSENCE READING, and this
 *      layer has none.
 *
 *   THERE IS NO `designated_absence` HERE, AND ITS ABSENCE IS THE INVERSION THE SIBLING FLOOD LAYER TAUGHT.
 *   For flood zones the Environment Agency states England-wide coverage and the Planning Practice Guidance
 *   defines Zone 1 as the land outside Zones 2 and 3, so an empty answer inside England IS a designation.
 *   NCERM publishes no coverage statement at all. A location in England with no erosion polygon is either
 *   inland — most of the country, about which the product says nothing — or on the coast and outside the
 *   mapped risk area, which is the designation a caller actually wants; and the published layers cannot tell
 *   those apart. A reader that generalized the flood rule would report the whole country as not at risk of
 *   coastal erosion, which is a well-formed wrong answer nobody would question.
 *
 *   SO THE CONSTRUCTOR REFUSES A COVERAGE ROW THAT WOULD SUPPORT AN EXCLUSION. Every row must read
 *   `source_present`; `supportsExclusion` must be false for all of them. That is not a convention this
 *   reader follows — it is a condition it checks at open time, so the day someone writes a stronger basis
 *   without settling the footprint question, the layer refuses to open rather than answering confidently.
 *
 *   NEITHER READING IS A STATEMENT ABOUT A PROPERTY. The layer reports what the authority's map assigns at a
 *   location under a named scenario, which is a fact about the map. The Environment Agency states that its
 *   data "cannot provide details for individual properties", and this reader never claims otherwise —
 *   `limits` carries the authority's own exclusions on every answer.
 *
 *   A PROBE MUST NAME ITS SCENARIO. Twelve layers answer twelve different questions, and a reader that
 *   picked one silently would let a 2105 projection be read as a present-day designation. An unknown
 *   scenario key throws rather than returning nothing, because "no such scenario" and "no zone here" are
 *   opposite facts that would otherwise look identical.
 *
 *   THE PROBE IS STRUCTURE FIRST, GEOMETRY LAST. `cellToParent` up the compacted whole-cell chain answers an
 *   interior point with primary-key probes alone; only a cell a boundary crosses reaches the ray cast, and
 *   then only against the polygons `coastal_zone_cell` already named for that cell and that scenario.
 *
 *   THE READER IS SYNCHRONOUS AND USES RAW PREPARED STATEMENTS, for the same reason the flood reader is: it
 *   answers one point per geocode with a bounded number of primary-key probes plus a bounded geometry read,
 *   and the ray cast it wraps is synchronous anyway. The DDL that created these tables IS Kysely — see
 *   `schema.ts`.
 */

import { DatabaseSync } from "node:sqlite"

import {
	assertCoverageLicensesNoExclusion,
	CoverageBasis,
	parseManifestRows,
	toCoverageCell,
	type CoverageRow,
	type CoverageCell,
	type LayerManifest,
} from "@mailwoman/core/layers"
import { recoverShortCellResolution, shortCellToInt, type H3Cell } from "@mailwoman/spatial"
import { cellToParent, latLngToCell } from "h3-js"

import { pointInEncodedRings } from "./rings.ts"
import { CoastalCellContainment } from "./schema.ts"
import {
	NCERM_COVERAGE_LIMIT,
	NCERM_LAYER_NAME,
	NCERM_PRODUCT_LIMITS,
	NCERM_SCENARIOS_BY_KEY,
	type CoastalScenario,
} from "./vocabulary.ts"

export { DEFAULT_NCERM_SCENARIO, NCERM_SCENARIOS, NCERM_SCENARIOS_BY_KEY, type CoastalScenario } from "./vocabulary.ts"

/**
 * What the layer can say about a coordinate under one scenario.
 */
export const CoastalReadingKind = {
	/**
	 * The authority's map places this location inside an erosion zone under the scenario asked for.
	 */
	Designated: "designated",
	/**
	 * No erosion polygon of that scenario contains the point. NEVER an absence reading — see this file's header.
	 */
	Unknown: "unknown",
} as const

export type CoastalReadingKind = (typeof CoastalReadingKind)[keyof typeof CoastalReadingKind]

/**
 * How containment was established.
 */
export const CoastalContainmentPath = {
	/**
	 * The cell lies wholly inside the zone; no geometry was read.
	 */
	WholeCell: "whole_cell",
	/**
	 * The cell is crossed by a boundary; the point was ray-cast against the polygons named for that cell.
	 */
	RayCast: "ray_cast",
	/**
	 * No zone of this scenario reaches this cell at all.
	 */
	NoZoneCell: "no_zone_cell",
} as const

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
	 * The medium- and long-term policy and its interpretation, where the scenario carries one. Absent on the NFI
	 * scenarios, where the source publishes none because no intervention is assumed.
	 */
	policy?: {
		mediumTerm: string | null
		mediumTermInterpretation: string | null
		longTerm: string | null
		longTermInterpretation: string | null
	}
	defenceType?: string
	/**
	 * 2024, or 0 on the 87 rows the authority publishes with blank policy and defence fields and documents no meaning
	 * for. Carried rather than coerced.
	 */
	publishedYear?: number
	/**
	 * How this polygon was reached.
	 */
	containment: CoastalContainmentPath
}

/**
 * One reading, carrying everything a caller needs to re-derive it rather than take it.
 */
export interface CoastalErosionReading {
	kind: CoastalReadingKind
	/**
	 * The scenario this reading answered under. Present on EVERY reading, including `unknown`: an answer whose scenario a
	 * reader cannot see is an answer to an unknown question.
	 */
	scenario: CoastalScenario
	/**
	 * Every polygon of that scenario containing the point, ordered by `area_id`. Usually one; several where the
	 * authority's own frontages overlap, which its `maxoverlap` column records on about half the rows of a measured
	 * layer. Empty on `unknown`.
	 */
	designations: CoastalDesignation[]
	/**
	 * How the answer was reached, across the scenario as a whole.
	 */
	containment: CoastalContainmentPath
	/**
	 * The coverage row for the location, when the product has data in that cell. Its basis is always `source_present`, so
	 * it licenses PRESENCE and nothing else — an absent coverage row and a present one are both compatible with "no
	 * erosion polygon here", and neither says the location is not at risk.
	 */
	coverage?: CoverageCell & { h3CellIndex: string; resolution: number }
	/**
	 * The index cell probed, for a receipt.
	 */
	indexCellIndex: string
	/**
	 * What the product does not cover, in the authority's own words.
	 */
	limits: ReadonlyArray<string>
	/**
	 * Why this layer's coverage licenses no negative claim, in one sentence.
	 */
	coverageLimit: string
}

/**
 * One ground-instability polygon containing a point. A DIFFERENT HAZARD, answered by its own method.
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
 * The layer's identity, read once at open time.
 */
export interface CoastalLayerIdentity {
	manifest: LayerManifest
	indexResolution: number
	coverageResolution: number
	/**
	 * Every resolution `coastal_zone_cell` stores a row at, coarsest first — the ancestor chain a probe walks.
	 *
	 * Several, and necessarily so: each feature's whole tier is compacted parent-ward, and a polygon too large for h3's
	 * allocator at the index resolution was indexed coarser. A reader that probed one resolution would read every row at
	 * the others as an absence.
	 */
	cellResolutions: number[]
	/**
	 * Every scenario key the layer holds, from its own vocabulary table.
	 */
	scenarioKeys: string[]
	/**
	 * The authority's footprint statements. EMPTY in this edition, which is what makes `source_present` the only basis
	 * the coverage may carry — see `schema.ts`.
	 */
	mappedExtents: Array<{ extentID: string; source: string; statement: string; statementURL: string }>
	/**
	 * The coverage basis every row carries. Always `source_present` while `mappedExtents` is empty; checked at open time
	 * rather than assumed.
	 */
	coverageBasis: CoverageBasis
	databasePath: string
}

export interface CoastalErosionLookupOptions {
	databasePath: string
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
 * Read a sealed `coastal-england.db`.
 *
 * Everything that would make the reader answer a well-formed wrong thing is refused at CONSTRUCTION rather than at
 * query time: a manifest naming a different layer, a coverage table with no rows, a coverage row whose basis would
 * support an exclusion, an empty scenario vocabulary. Each of those would otherwise present as a reader that quietly
 * always answers `unknown` — or, in the exclusion case, as a reader that confidently reports England as free of coastal
 * erosion.
 */
export class CoastalErosionLookup {
	readonly identity: CoastalLayerIdentity

	readonly #database: DatabaseSync
	readonly #selectCell: ReturnType<DatabaseSync["prepare"]>
	readonly #selectArea: ReturnType<DatabaseSync["prepare"]>
	readonly #selectAreaRings: ReturnType<DatabaseSync["prepare"]>
	readonly #selectCoverage: ReturnType<DatabaseSync["prepare"]>
	readonly #selectInstability: ReturnType<DatabaseSync["prepare"]>
	readonly #selectInstabilityRings: ReturnType<DatabaseSync["prepare"]>

	constructor(options: CoastalErosionLookupOptions) {
		this.#database = new DatabaseSync(options.databasePath, { readOnly: true })

		try {
			this.identity = readIdentity(this.#database, options.databasePath)
		} catch (error) {
			this.#database.close()

			throw error
		}

		this.#selectCell = this.#database.prepare(
			"SELECT area_id, containment FROM coastal_zone_cell WHERE h3_cell = ? AND scenario_key = ?"
		)

		// TWO STATEMENTS, AND THE SPLIT IS THE POINT. The attributes and the bbox are read WITHOUT the blob, because the
		// bbox is the ray cast's prefilter: pulling hundreds of thousands of vertices off disk only to reject the polygon
		// on a rectangle would make the prefilter cost more than the test it replaces. A `whole` cell never reads the blob
		// at all.
		this.#selectArea = this.#database.prepare(
			"SELECT area_id, frontage_id, distance_m, smp_no, smp_name, smp_pu, mt_policy, mt_policy_interp, lt_policy, " +
				"lt_policy_interp, defence_type, published_year, min_lat, min_lon, max_lat, max_lon " +
				"FROM coastal_zone_area WHERE area_id = ?"
		)

		this.#selectAreaRings = this.#database.prepare("SELECT rings FROM coastal_zone_area WHERE area_id = ?")

		this.#selectCoverage = this.#database.prepare(
			"SELECT h3_cell, completeness, basis, observed_rows FROM layer_coverage WHERE h3_cell = ?"
		)

		// 160 rows, so the bounding-box prefilter is a table scan and that is the cheapest correct thing. The blob is read
		// separately for the same reason as above.
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
	 * What the authority's map assigns at this coordinate, under one named scenario.
	 *
	 * @throws {Error} When `scenarioKey` names no scenario this layer holds. Returning an empty reading instead would
	 *   make a typo indistinguishable from a coast the authority has not mapped.
	 */
	public lookup(latitude: number, longitude: number, scenarioKey: string): CoastalErosionReading {
		const scenario = NCERM_SCENARIOS_BY_KEY.get(scenarioKey)

		if (!scenario || !this.identity.scenarioKeys.includes(scenarioKey)) {
			throw new Error(
				`coastal reader: ${JSON.stringify(scenarioKey)} is not a scenario this layer holds (${this.identity.scenarioKeys.join(", ")}) — ` +
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
	 * The ground-instability polygons containing this coordinate — a DIFFERENT HAZARD from erosion, and never an answer
	 * to an erosion question.
	 *
	 * Its own method rather than a field on the erosion reading, because the two are different hazards with different
	 * schemas and different authorities' meaning behind them. A caller that wants both asks for both.
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
	 * Walk the index for one scenario, falling through to the geometry only for a cell a boundary crosses.
	 */
	#resolveDesignations(
		indexCell: H3Cell,
		latitude: number,
		longitude: number,
		scenarioKey: string
	): { designations: CoastalDesignation[]; containment: CoastalContainmentPath } {
		// The stored rows sit at SEVERAL resolutions: each feature's whole tier is compacted parent-ward, and a polygon
		// whose bounding box would not fit h3's allocator at the index resolution was indexed coarser (see `sdk/cells.ts`).
		// So a point is answered by walking its own ancestor chain over every resolution the layer stores.
		const whole = new Map<string, string>()
		const partial = new Set<string>()

		for (const resolution of this.identity.cellResolutions) {
			const cell =
				resolution === this.identity.indexResolution ? indexCell : (cellToParent(indexCell, resolution) as H3Cell)

			const rows = this.#selectCell.all(shortCellToInt(cell), scenarioKey) as Array<{
				area_id: string
				containment: string
			}>

			for (const row of rows) {
				if (row.containment === CoastalCellContainment.Whole) {
					whole.set(row.area_id, row.area_id)
				} else {
					partial.add(row.area_id)
				}
			}
		}

		const designations: CoastalDesignation[] = []

		for (const areaID of [...whole.keys()].toSorted()) {
			const area = this.#selectArea.get(areaID) as AreaRow | undefined

			if (area) {
				designations.push(toDesignation(area, CoastalContainmentPath.WholeCell))
			}
		}

		let rayCastRan = false

		for (const areaID of [...partial].toSorted()) {
			// A polygon that already answered `whole` higher in the chain needs no geometry read.
			if (whole.has(areaID)) continue

			const area = this.#selectArea.get(areaID) as AreaRow | undefined

			if (!area) continue

			rayCastRan = true

			// The bbox is the prefilter the geometry table stores precisely so the ray cast runs on the few polygons that
			// could contain the point rather than on every polygon reaching the cell.
			if (longitude < area.min_lon || longitude > area.max_lon || latitude < area.min_lat || latitude > area.max_lat) {
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
 * One stored row as a designation.
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
		// The four policy fields travel together or not at all: an NFI row has no policy because the scenario assumes no
		// intervention, and a half-populated policy object would read as a policy the authority declined to state.
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
function readIdentity(database: DatabaseSync, databasePath: string): CoastalLayerIdentity {
	const manifestRows = database.prepare("SELECT * FROM layer_manifest").all() as Array<
		Record<string, string | number | null>
	>

	const manifest = parseManifestRows(manifestRows, NCERM_LAYER_NAME, `coastal reader: ${databasePath}`)
	const spineKeys = manifest.spineKeys

	if (!spineKeys.h3) {
		throw new Error(`coastal reader: ${databasePath} declares no h3 spine key`)
	}

	// THE EXCLUSION CHECK, AND IT IS A CONDITION RATHER THAN A CONVENTION. NCERM publishes no coverage statement, so no
	// row of this layer may license a claim that a location is NOT at risk. A stronger basis reaching a caller would let
	// an absent polygon be read as a designation of safety over the whole of inland England. The check itself is the
	// contract's rather than this product's; the SENTENCE saying why is this product's.
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
	const finerThanIndex = cellResolutions.filter((resolution) => resolution > indexResolution)

	// A stored cell finer than the manifest's declared index resolution has no ancestor chain from the probe's own cell,
	// so `cellToParent` would throw mid-query on some coordinates and not others. Refused here instead: it means the
	// manifest and the rows disagree about what the layer is, which is a build defect rather than a runtime condition.
	if (finerThanIndex.length) {
		throw new Error(
			`coastal reader: ${databasePath} stores cells at resolution(s) ${finerThanIndex.join(", ")}, finer than the manifest's declared index resolution ${indexResolution} — the manifest and the rows disagree`
		)
	}

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

	// THE COVERAGE RESOLUTION IS RECOVERED FROM THE CELLS, NOT DECLARED. The manifest's spine key names the INDEX
	// resolution; `layer_coverage` is keyed at a coarser one, and this layer has no footprint row to carry it (the flood
	// layer's `flood_map_extent` and the soil layer's survey-area rows are where those two put theirs, and NCERM publishes
	// no footprint at all). Recovering it is exact rather than approximate — a short cell expands to a valid index at
	// exactly one resolution — and the shared helper throws on a table that mixes them.
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
