/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The `zoning-ireland.db` reader — what a local authority's adopted plan assigns at a coordinate, in that
 *   authority's own vocabulary, and on what basis.
 *
 *   TWO READINGS, AND THE ONE THAT IS MISSING IS THE POINT.
 *
 *   1. `designated` — an adopted plan places the location inside a zoning polygon, and the polygon is the
 *      answer: the authority's own code, its own description, the plan it belongs to and that plan's stated
 *      window, with the Department's national generic type BESIDE the local code rather than instead of it.
 *   2. `unknown` — no polygon contains the point. THAT IS NOT AN ABSENCE READING, and this layer has none.
 *
 *   THERE IS NO `designated_absence` HERE, AND ZONING IS THE HARDEST CASE OF THE RULE. For flood zones the
 *   Environment Agency states England-wide coverage and the Planning Practice Guidance defines Zone 1 as the
 *   land outside Zones 2 and 3, so an empty answer inside England IS a designation. No such definition exists
 *   anywhere for zoning: a location with no zoning polygon is outside any adopted plan area, or inside one on
 *   land the plan does not zone, or in a jurisdiction that has never adopted zoning, or in a jurisdiction
 *   whose records nobody has published — and no product distinguishes them. The source itself proves the
 *   asymmetry: it states `UNZ - Unzoned` as a POSITIVE value on 4 of 85,330 rows, so where the authority
 *   means unzoned it says so, and every other absence is a row that is not there.
 *
 *   SO THE CONSTRUCTOR REFUSES A COVERAGE ROW THAT WOULD SUPPORT AN EXCLUSION. Every row must read
 *   `source_present`; `supportsExclusion` must be false for all of them. That is not a convention this reader
 *   follows — it is a condition it checks at open time, so the day someone writes a stronger basis without
 *   settling the footprint question, the layer refuses to open rather than answering confidently.
 *
 *   NEITHER READING IS A STATEMENT ABOUT WHAT MAY BE BUILT. The layer reports what a plan assigns at a
 *   location, which is a fact about the plan. The Department states that its data are "not published here as
 *   legal definitions of the current actuality with regard to Local Authority zoning or their geographic
 *   extents" and that "Original data should be sourced directly from the relevant Local Authority" — and
 *   `limits` carries the authority's own exclusions on every answer.
 *
 *   THE PLAN IS PART OF THE CLAIM, NEVER A PARAMETER OF IT. A zone exists inside a named Development Plan or
 *   Local Area Plan with a stated validity window; a reading that dropped the plan would answer a question no
 *   authority asked. And `currentPlan = 1` means "not superseded", not "in force today": 2,363 of 85,330 rows
 *   carry a `validTo` already in the past, so the window travels on every reading and the comparison against a
 *   date is the caller's, made against a clock this reader does not own.
 *
 *   THE PROBE IS STRUCTURE FIRST, GEOMETRY LAST. `cellToParent` up the compacted whole-cell chain answers an
 *   interior point with primary-key probes alone; only a cell a boundary crosses reaches the ray cast, and
 *   then only against the polygons `zoning_cell` already named for that cell.
 *
 *   THE READER IS SYNCHRONOUS AND USES RAW PREPARED STATEMENTS, for the same reason the sibling layer readers
 *   are: it answers one point per geocode with a bounded number of primary-key probes plus a bounded geometry
 *   read, and the ray cast it wraps is synchronous anyway. The DDL that created these tables IS Kysely — see
 *   `schema.ts`.
 */

import {
	assertCoverageLicensesNoExclusion,
	CoverageBasis,
	parseManifestRows,
	toCoverageCell,
	type CoverageCell,
	type CoverageRow,
	type LayerManifest,
} from "@mailwoman/core/layers"
import { recoverShortCellResolution, shortCellToInt, type H3Cell } from "@mailwoman/spatial"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { cellToParent, latLngToCell } from "h3-js"

import { pointInEncodedRings } from "#rings"
import type { ZoningDatabase } from "#schema"
import { ZoningCellContainment } from "#schema"
import {
	GZT_COVERAGE_LIMIT,
	GZT_CROSSWALK_SCHEME,
	GZT_LAYER_NAME,
	GZT_PRODUCT_LIMITS,
	GZT_UNZONED_LOCAL_CODE,
} from "#vocabulary"

export { GZT_LAYER_NAME, ProvenanceGrade } from "#vocabulary"

/**
 * What the layer can say about a coordinate.
 */
export const ZoningReadingKind = {
	/**
	 * An adopted plan places this location inside a zoning polygon.
	 */
	Designated: "designated",
	/**
	 * No zoning polygon contains the point. NEVER an absence reading — see this file's header.
	 */
	Unknown: "unknown",
} as const

export type ZoningReadingKind = (typeof ZoningReadingKind)[keyof typeof ZoningReadingKind]

/**
 * How containment was established.
 */
export const ZoningContainmentPath = {
	/**
	 * The cell lies wholly inside the zone; no geometry was read.
	 */
	WholeCell: "whole_cell",
	/**
	 * The cell is crossed by a boundary; the point was ray-cast against the polygons named for that cell.
	 */
	RayCast: "ray_cast",
	/**
	 * No zone reaches this cell at all.
	 */
	NoZoneCell: "no_zone_cell",
} as const

export type ZoningContainmentPath = (typeof ZoningContainmentPath)[keyof typeof ZoningContainmentPath]

/**
 * The authority that adopted the plan.
 */
export interface ZoningJurisdiction {
	jurisdictionID: string
	name: string
	/**
	 * The publisher's own code, verbatim — `Fl` for Fingal, against `CL`, `CO`, `DU` for the rest.
	 */
	sourceCode: string
	country: string
}

/**
 * The plan a zone belongs to, with its own stated window.
 */
export interface ZoningPlan {
	planID: string
	name: string
	/**
	 * `DP` Development Plan, `LAP` Local Area Plan, `SDZ` Strategic Development Zone.
	 */
	level: string
	validFrom: string | null
	validTo: string | null
	/**
	 * The publisher's `CURRENT_PLAN` flag, carried as published. `1` means NOT SUPERSEDED — not "in force today".
	 */
	currentPlan: number
}

/**
 * One zoning polygon the point falls inside, as the authority publishes it.
 */
export interface ZoningDesignation {
	areaID: string
	/**
	 * The authority's own zone code, verbatim.
	 */
	localCode: string
	localDescription: string | null
	localCodeURL: string | null
	/**
	 * The publishing authority's OWN crosswalk into a shared scheme, where it publishes one. Beside the local code, never
	 * instead of it: 52 of 795 (authority, local code) pairs take more than one generic type, so this cannot be
	 * reconstructed from `localCode` and is a per-polygon fact the Department authored.
	 */
	crosswalk?: {
		scheme: string
		code: string
		description: string | null
		/**
		 * A coarser code from the same authority, carried as published.
		 */
		rollup: string | null
		/**
		 * The publisher's own label for `code`, from its declared domain — absent for a code the publisher uses and never
		 * declared.
		 */
		label?: string
		/**
		 * `false` where the publisher uses this code without declaring it in its own domain.
		 */
		declared: boolean
	}
	/**
	 * One of {@link ProvenanceGrade}. Every row of THIS artifact is `authoritative`; the column exists because a query
	 * answered from an `inferred` row may never be presented as the authority's designation.
	 */
	provenanceGrade: string
	jurisdiction: ZoningJurisdiction
	plan: ZoningPlan
	/**
	 * The authority states unzoned land POSITIVELY on a handful of rows. `true` here is the authority saying so; an
	 * ABSENT designation says nothing at all, which is the distinction this layer exists to keep.
	 */
	unzoned: boolean
	containment: ZoningContainmentPath
}

/**
 * One reading, carrying everything a caller needs to re-derive it rather than take it.
 */
export interface ZoningReading {
	kind: ZoningReadingKind
	/**
	 * Every polygon containing the point, ordered by `area_id`. Usually one; several where a Local Area Plan overlays a
	 * Development Plan over the same ground, which the source publishes as two rows.
	 */
	designations: ZoningDesignation[]
	containment: ZoningContainmentPath
	/**
	 * The coverage row for the location, when the product has data in that cell. Its basis is always `source_present`, so
	 * it licenses PRESENCE and nothing else — an absent coverage row and a present one are both compatible with "no
	 * zoning polygon here", and neither says the location is unrestricted.
	 */
	coverage?: CoverageCell & { h3CellIndex: string; resolution: number }
	/**
	 * The index cell probed, for a receipt.
	 */
	indexCellIndex: string
	/**
	 * What the product does not state, in the authority's own words.
	 */
	limits: ReadonlyArray<string>
	/**
	 * Why this layer's coverage licenses no negative claim, in one sentence.
	 */
	coverageLimit: string
}

/**
 * The layer's identity, read once at open time.
 */
export interface ZoningLayerIdentity {
	manifest: LayerManifest
	indexResolution: number
	coverageResolution: number
	/**
	 * Every resolution `zoning_cell` stores a row at, coarsest first — the ancestor chain a probe walks.
	 *
	 * Several, and necessarily so: each feature's whole tier is compacted parent-ward, and a polygon too large for h3's
	 * allocator at the index resolution was indexed coarser. A reader that probed one resolution would read every row at
	 * the others as an absence.
	 */
	cellResolutions: number[]
	/**
	 * The jurisdictions the layer holds, by id.
	 */
	jurisdictions: ReadonlyMap<string, ZoningJurisdiction>
	/**
	 * The crosswalk scheme this layer's rows carry, or `undefined` where the publisher ships none.
	 */
	crosswalkScheme?: string
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

export interface ZoningLookupOptions {
	databasePath: string
}

interface AreaRow {
	area_id: string
	jurisdiction_id: string
	plan_id: string
	local_code: string
	local_description: string | null
	local_code_url: string | null
	crosswalk_code: string | null
	crosswalk_scheme: string | null
	crosswalk_description: string | null
	crosswalk_rollup: string | null
	provenance_grade: string
	min_lat: number
	min_lon: number
	max_lat: number
	max_lon: number
}

interface PlanRow {
	plan_id: string
	plan_name: string
	plan_level: string
	valid_from: string | null
	valid_to: string | null
	current_plan: number
}

/**
 * Read a sealed `zoning-ireland.db`.
 *
 * Everything that would make the reader answer a well-formed wrong thing is refused at CONSTRUCTION rather than at
 * query time: a manifest naming a different layer, a coverage table with no rows, a coverage row whose basis would
 * support an exclusion, an empty jurisdiction table. Each of those would otherwise present as a reader that quietly
 * always answers `unknown` — or, in the exclusion case, as a reader that confidently reports unzoned-and-unmapped land
 * as free of restriction.
 */
export class ZoningLookup implements Disposable {
	readonly identity: ZoningLayerIdentity

	readonly #database: DatabaseClient<ZoningDatabase>
	readonly #selectCell: ReturnType<DatabaseClient["prepare"]>
	readonly #selectArea: ReturnType<DatabaseClient["prepare"]>
	readonly #selectAreaRings: ReturnType<DatabaseClient["prepare"]>
	readonly #selectPlan: ReturnType<DatabaseClient["prepare"]>
	readonly #selectCoverage: ReturnType<DatabaseClient["prepare"]>
	readonly #crosswalkTerms: ReadonlyMap<string, { label: string; declared: boolean }>

	constructor(options: ZoningLookupOptions) {
		this.#database = new DatabaseClient<ZoningDatabase>(options.databasePath, { readOnly: true })

		try {
			this.identity = readIdentity(this.#database, options.databasePath)
			this.#crosswalkTerms = readCrosswalkTerms(this.#database)
		} catch (error) {
			this.#database.destroy()

			throw error
		}

		this.#selectCell = this.#database.prepare("SELECT area_id, containment FROM zoning_cell WHERE h3_cell = ?")

		// TWO STATEMENTS, AND THE SPLIT IS THE POINT. The attributes and the bbox are read WITHOUT the blob, because the
		// bbox is the ray cast's prefilter: pulling hundreds of thousands of vertices off disk only to reject the polygon on
		// a rectangle would make the prefilter cost more than the test it replaces. A `whole` cell never reads the blob at
		// all.
		this.#selectArea = this.#database.prepare(
			"SELECT area_id, jurisdiction_id, plan_id, local_code, local_description, local_code_url, crosswalk_code, " +
				"crosswalk_scheme, crosswalk_description, crosswalk_rollup, provenance_grade, min_lat, min_lon, max_lat, max_lon " +
				"FROM zoning_area WHERE area_id = ?"
		)

		this.#selectAreaRings = this.#database.prepare("SELECT rings FROM zoning_area WHERE area_id = ?")

		this.#selectPlan = this.#database.prepare(
			"SELECT plan_id, plan_name, plan_level, valid_from, valid_to, current_plan FROM zoning_plan WHERE plan_id = ?"
		)

		this.#selectCoverage = this.#database.prepare(
			"SELECT h3_cell, completeness, basis, observed_rows FROM layer_coverage WHERE h3_cell = ?"
		)
	}

	/**
	 * What an adopted plan assigns at this coordinate.
	 */
	public lookup(latitude: number, longitude: number): ZoningReading {
		const indexCell = latLngToCell(latitude, longitude, this.identity.indexResolution) as H3Cell
		const coverage = this.#readCoverage(indexCell)
		const resolved = this.#resolveDesignations(indexCell, latitude, longitude)

		return {
			kind: resolved.designations.length ? ZoningReadingKind.Designated : ZoningReadingKind.Unknown,
			designations: resolved.designations,
			containment: resolved.containment,
			...(coverage ? { coverage } : {}),
			indexCellIndex: indexCell,
			limits: GZT_PRODUCT_LIMITS,
			coverageLimit: GZT_COVERAGE_LIMIT,
		}
	}

	public [Symbol.dispose](): void {
		this.#database.destroy()
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
	#resolveDesignations(
		indexCell: H3Cell,
		latitude: number,
		longitude: number
	): { designations: ZoningDesignation[]; containment: ZoningContainmentPath } {
		// The stored rows sit at SEVERAL resolutions: each feature's whole tier is compacted parent-ward, and a polygon
		// whose bounding box would not fit h3's allocator at the index resolution was indexed coarser (see `sdk/cells.ts`).
		// So a point is answered by walking its own ancestor chain over every resolution the layer stores.
		const whole = new Set<string>()
		const partial = new Set<string>()

		for (const resolution of this.identity.cellResolutions) {
			const cell =
				resolution === this.identity.indexResolution ? indexCell : (cellToParent(indexCell, resolution) as H3Cell)

			const rows = this.#selectCell.all(shortCellToInt(cell)) as Array<{ area_id: string; containment: string }>

			for (const row of rows) {
				if (row.containment === ZoningCellContainment.Whole) {
					whole.add(row.area_id)
				} else {
					partial.add(row.area_id)
				}
			}
		}

		const designations: ZoningDesignation[] = []

		for (const areaID of [...whole].toSorted()) {
			const area = this.#selectArea.get(areaID) as AreaRow | undefined

			if (area) {
				designations.push(this.#toDesignation(area, ZoningContainmentPath.WholeCell))
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
				designations.push(this.#toDesignation(area, ZoningContainmentPath.RayCast))
			}
		}

		if (designations.length) {
			designations.sort((left, right) => (left.areaID < right.areaID ? -1 : 1))

			return {
				designations,
				containment: whole.size ? ZoningContainmentPath.WholeCell : ZoningContainmentPath.RayCast,
			}
		}

		return {
			designations,
			containment: rayCastRan ? ZoningContainmentPath.RayCast : ZoningContainmentPath.NoZoneCell,
		}
	}

	/**
	 * One stored row as a designation, with its plan and its authority attached.
	 */
	#toDesignation(area: AreaRow, containment: ZoningContainmentPath): ZoningDesignation {
		const plan = this.#selectPlan.get(area.plan_id) as PlanRow | undefined

		const jurisdiction = this.identity.jurisdictions.get(area.jurisdiction_id) ?? {
			jurisdictionID: area.jurisdiction_id,
			name: area.jurisdiction_id,
			sourceCode: area.jurisdiction_id,
			country: "",
		}

		const term = area.crosswalk_code === null ? undefined : this.#crosswalkTerms.get(area.crosswalk_code)

		return {
			areaID: area.area_id,
			localCode: area.local_code,
			localDescription: area.local_description,
			localCodeURL: area.local_code_url,
			// The crosswalk travels as one object or not at all: a code without its scheme reads as a code in whichever
			// vocabulary the consumer happened to assume.
			...(area.crosswalk_code === null || area.crosswalk_scheme === null
				? {}
				: {
						crosswalk: {
							scheme: area.crosswalk_scheme,
							code: area.crosswalk_code,
							description: area.crosswalk_description,
							rollup: area.crosswalk_rollup,
							...(term ? { label: term.label } : {}),
							declared: term?.declared ?? false,
						},
					}),
			provenanceGrade: area.provenance_grade,
			jurisdiction,
			plan: {
				planID: area.plan_id,
				name: plan?.plan_name ?? area.plan_id,
				level: plan?.plan_level ?? "",
				validFrom: plan?.valid_from ?? null,
				validTo: plan?.valid_to ?? null,
				currentPlan: plan?.current_plan ?? 0,
			},
			unzoned: area.local_code === GZT_UNZONED_LOCAL_CODE,
			containment,
		}
	}
}

/**
 * The publisher's crosswalk domain, by code — its label and whether the publisher DECLARED it.
 */
function readCrosswalkTerms(
	database: DatabaseClient<ZoningDatabase>
): ReadonlyMap<string, { label: string; declared: boolean }> {
	const rows = database
		.prepare("SELECT code, label, declared FROM zoning_vocabulary WHERE scheme = ?")
		.all(GZT_CROSSWALK_SCHEME) as Array<{ code: string; label: string; declared: number }>

	return new Map(rows.map((row) => [row.code, { label: row.label, declared: row.declared === 1 }]))
}

/**
 * Read and check the layer's identity.
 */
function readIdentity(database: DatabaseClient<ZoningDatabase>, databasePath: string): ZoningLayerIdentity {
	const manifest = parseManifestRows(
		database.prepare("SELECT * FROM layer_manifest").all() as Array<Record<string, string | number | null>>,
		GZT_LAYER_NAME,
		`zoning reader: ${databasePath}`
	)

	const spineKeys = manifest.spineKeys

	if (!spineKeys.h3) {
		throw new Error(`zoning reader: ${databasePath} declares no h3 spine key`)
	}

	// THE EXCLUSION CHECK, AND IT IS A CONDITION RATHER THAN A CONVENTION. The Department publishes its coverage detail
	// only inside a map viewer, so no row of this layer may license a claim that a location is unrestricted. A stronger
	// basis reaching a caller would let an absent polygon be read as a designation of freedom to build over most of the
	// map. The check itself is the contract's rather than this product's; the SENTENCE saying why is this product's.
	assertCoverageLicensesNoExclusion(
		(database.prepare("SELECT DISTINCT basis FROM layer_coverage").all() as Array<{ basis: string | null }>).map(
			(coverageRow) => coverageRow.basis
		),
		`zoning reader: ${databasePath}`,
		GZT_COVERAGE_LIMIT
	)

	const extentRows = database.prepare("SELECT * FROM zoning_mapped_extent ORDER BY extent_id").all() as Array<
		Record<string, string | number>
	>

	const cellResolutions = (
		database.prepare("SELECT DISTINCT resolution FROM zoning_cell ORDER BY resolution").all() as Array<{
			resolution: number
		}>
	).map((entry) => entry.resolution)

	const indexResolution = spineKeys.h3.resolution
	const finerThanIndex = cellResolutions.filter((resolution) => resolution > indexResolution)

	// A stored cell finer than the manifest's declared index resolution has no ancestor chain from the probe's own cell, so
	// `cellToParent` would throw mid-query on some coordinates and not others. Refused here instead: it means the manifest
	// and the rows disagree about what the layer is, which is a build defect rather than a runtime condition.
	if (finerThanIndex.length) {
		throw new Error(
			`zoning reader: ${databasePath} stores cells at resolution(s) ${finerThanIndex.join(", ")}, finer than the manifest's declared index resolution ${indexResolution} — the manifest and the rows disagree`
		)
	}

	const jurisdictionRows = database
		.prepare("SELECT jurisdiction_id, name, source_code, country FROM zoning_jurisdiction ORDER BY jurisdiction_id")
		.all() as Array<{ jurisdiction_id: string; name: string; source_code: string; country: string }>

	if (!jurisdictionRows.length) {
		throw new Error(
			`zoning reader: ${databasePath} names no jurisdiction — a designation whose authority a reader cannot see is a designation nobody can check`
		)
	}

	const crosswalkScheme = (
		database
			.prepare("SELECT DISTINCT crosswalk_scheme FROM zoning_area WHERE crosswalk_scheme IS NOT NULL")
			.all() as Array<{ crosswalk_scheme: string }>
	).map((entry) => entry.crosswalk_scheme)

	// THE COVERAGE RESOLUTION IS RECOVERED FROM THE CELLS, NOT DECLARED. The manifest's spine key names the INDEX
	// resolution; `layer_coverage` is keyed at a coarser one, and this layer has no footprint row to carry it. Recovering
	// it is exact rather than approximate — a short cell expands to a valid index at exactly one resolution — and the
	// shared helper throws on a table that mixes them.
	const coverageResolution = recoverShortCellResolution(
		(database.prepare("SELECT h3_cell FROM layer_coverage").all() as Array<{ h3_cell: number }>).map(
			(coverageRow) => coverageRow.h3_cell
		),
		`zoning reader: ${databasePath}`
	)

	return {
		manifest,
		indexResolution,
		coverageResolution,
		cellResolutions,
		jurisdictions: new Map(
			jurisdictionRows.map((entry) => [
				entry.jurisdiction_id,
				{
					jurisdictionID: entry.jurisdiction_id,
					name: entry.name,
					sourceCode: entry.source_code,
					country: entry.country,
				},
			])
		),
		...(crosswalkScheme[0] ? { crosswalkScheme: crosswalkScheme[0] } : {}),
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
