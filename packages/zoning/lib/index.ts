/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Synchronous reader for `zoning-ireland.db` that returns the zoning an adopted local plan assigns at a coordinate.
 */

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
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { latLngToCell } from "h3-js"
import type { PathBuilderLike } from "path-ts"

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
 * The kinds of answer the layer gives for a coordinate.
 *
 * The layer has no absence kind.
 * A point with no zoning polygon may be outside every plan area, on land that a plan leaves unzoned,
 * or in a jurisdiction whose records are unpublished, and the source does not distinguish these cases.
 */
export const ZoningReadingKind = {
	/**
	 * An adopted plan places this location inside a zoning polygon.
	 */
	Designated: "designated",
	/**
	 * No zoning polygon contains the point.
	 * This kind never means the location is unzoned.
	 */
	Unknown: "unknown",
} as const

/**
 * One of the {@link ZoningReadingKind} values.
 */
export type ZoningReadingKind = (typeof ZoningReadingKind)[keyof typeof ZoningReadingKind]

/**
 * How the lookup established containment.
 */
export const ZoningContainmentPath = {
	/**
	 * The cell lies wholly inside the zone, so no geometry was read.
	 */
	WholeCell: "whole_cell",
	/**
	 * A boundary crosses the cell, so the point was ray-cast against the cell's polygons.
	 */
	RayCast: "ray_cast",
	/**
	 * No zone reaches this cell.
	 */
	NoZoneCell: "no_zone_cell",
} as const

/**
 * One of the {@link ZoningContainmentPath} values.
 */
export type ZoningContainmentPath = (typeof ZoningContainmentPath)[keyof typeof ZoningContainmentPath]

/**
 * The authority that adopted the plan.
 */
export interface ZoningJurisdiction {
	jurisdictionID: string
	name: string
	/**
	 * The publisher's code, verbatim.
	 *
	 * Fingal uses `Fl`, while other councils use codes such as `CL`, `CO` and `DU`.
	 */
	sourceCode: string
	country: string
}

/**
 * The plan that a zone belongs to, with its stated validity window.
 *
 * The caller must compare the window with the current date, because a plan that is
 * not superseded can still have a `validTo` in the past.
 */
export interface ZoningPlan {
	planID: string
	name: string
	/**
	 * The plan level: `DP` for Development Plan, `LAP` for Local Area Plan
	 * or `SDZ` for Strategic Development Zone.
	 */
	level: string
	validFrom: string | null
	validTo: string | null
	/**
	 * The publisher's `CURRENT_PLAN` flag as published.
	 *
	 * The value `1` means the plan is not superseded.
	 * It does not mean the plan is in force today.
	 */
	currentPlan: number
}

/**
 * One zoning polygon that contains the point, as the authority publishes it.
 */
export interface ZoningDesignation {
	areaID: string
	/**
	 * The authority's zone code, verbatim.
	 */
	localCode: string
	localDescription: string | null
	localCodeURL: string | null
	/**
	 * The publisher's crosswalk from the local code into a shared scheme, when it publishes one.
	 *
	 * The crosswalk is stored per polygon because one local code can map to several
	 * generic types, so it cannot be derived from `localCode`.
	 */
	crosswalk?: {
		scheme: string
		code: string
		description: string | null
		/**
		 * A coarser code from the same authority, as published.
		 */
		rollup: string | null
		/**
		 * The publisher's label for `code` from its declared domain.
		 *
		 * It is absent for a code that the publisher uses without declaring.
		 */
		label?: string
		/**
		 * Whether the publisher declares this code in its own domain.
		 */
		declared: boolean
	}
	/**
	 * One of {@link ProvenanceGrade}.
	 *
	 * Every row of this artifact is `authoritative`.
	 * A caller must never present an `inferred` row as the authority's designation.
	 */
	provenanceGrade: string
	jurisdiction: ZoningJurisdiction
	plan: ZoningPlan
	/**
	 * Whether the authority explicitly zones this polygon as unzoned.
	 *
	 * Only this flag means unzoned.
	 * A point with no designation makes no statement about zoning.
	 */
	unzoned: boolean
	containment: ZoningContainmentPath
}

/**
 * One reading at a coordinate, with the provenance a caller needs to check it.
 */
export interface ZoningReading {
	kind: ZoningReadingKind
	/**
	 * Every polygon that contains the point, ordered by `area_id`.
	 *
	 * A Local Area Plan that overlays a Development Plan produces two designations for the same ground.
	 */
	designations: ZoningDesignation[]
	containment: ZoningContainmentPath
	/**
	 * The coverage row for the location, when the product has data in that cell.
	 *
	 * Its basis is always `source_present`, which only shows that the source has data nearby.
	 * Neither a present nor an absent coverage row means the location is unrestricted.
	 */
	coverage?: CoverageCell & { h3CellIndex: string; resolution: number }
	/**
	 * The H3 index cell that the lookup probed.
	 */
	indexCellIndex: string
	/**
	 * The authority's own statements of what the product does not state.
	 */
	limits: ReadonlyArray<string>
	/**
	 * One sentence on why this layer's coverage supports no negative claim.
	 */
	coverageLimit: string
}

/**
 * The layer's identity, read once when the database opens.
 */
export interface ZoningLayerIdentity {
	manifest: LayerManifest
	indexResolution: number
	coverageResolution: number
	/**
	 * Every resolution at which `zoning_cell` stores rows, coarsest first.
	 *
	 * A probe walks all of them because whole cells are compacted into parents, and a polygon
	 * too large for the h3 allocator at the index resolution was indexed at a coarser one.
	 */
	cellResolutions: number[]
	/**
	 * The jurisdictions in the layer, keyed by id.
	 */
	jurisdictions: ReadonlyMap<string, ZoningJurisdiction>
	/**
	 * The crosswalk scheme of this layer's rows, or `undefined` when the publisher ships none.
	 */
	crosswalkScheme?: string
	/**
	 * The authority's footprint statements.
	 *
	 * This edition has none, so `source_present` is the only coverage basis allowed.
	 * See `schema.ts`.
	 */
	mappedExtents: Array<{ extentID: string; source: string; statement: string; statementURL: string }>
	/**
	 * The coverage basis of every row.
	 * It is `source_present` while `mappedExtents` is empty.
	 */
	coverageBasis: CoverageBasis
	databasePath: string
}

/**
 * Options for {@link ZoningLookup}.
 */
export interface ZoningLookupOptions {
	databasePath: PathBuilderLike
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
 * Reads a sealed `zoning-ireland.db`.
 *
 * The constructor throws on a manifest for a different layer, an empty coverage table,
 * a coverage basis that supports exclusion or an empty jurisdiction table.
 * These would otherwise make the reader
 * return `unknown` everywhere, or let a caller read unmapped land as free of restriction.
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
			this.identity = readIdentity(this.#database, options.databasePath.toString())
			this.#crosswalkTerms = readCrosswalkTerms(this.#database)
		} catch (error) {
			this.#database.destroy()

			throw error
		}

		this.#selectCell = this.#database.prepare("SELECT area_id, containment FROM zoning_cell WHERE h3_cell = ?")

		// The attributes and bounding box are read without the ring blob, because the
		// bounding box rejects most polygons before the ray cast needs the rings.
		// A whole cell never reads the blob.
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
	 * Returns what an adopted plan assigns at this coordinate.
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
	 * Returns the coverage row for the index cell's parent at the coverage resolution.
	 */
	#readCoverage(indexCell: H3Cell): (CoverageCell & { h3CellIndex: string; resolution: number }) | undefined {
		return readCoverageAt(this.#selectCoverage, indexCell, this.identity.coverageResolution)
	}

	/**
	 * Walks the cell index up the ancestor chain and reads geometry only for cells that a boundary crosses.
	 */
	#resolveDesignations(
		indexCell: H3Cell,
		latitude: number,
		longitude: number
	): { designations: ZoningDesignation[]; containment: ZoningContainmentPath } {
		const whole = new Set<string>()
		const partial = new Set<string>()

		for (const cell of ancestorChainCells(indexCell, this.identity.indexResolution, this.identity.cellResolutions)) {
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
			// A polygon that already matched as whole needs no geometry read.
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
	 * Converts a stored row to a designation with its plan and jurisdiction.
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
			// The crosswalk is omitted unless both the code and its scheme are present.
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
 * Reads the publisher's crosswalk domain as a map from code to label and declared flag.
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
 * Reads the layer's identity and throws if it is unusable.
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

	// The Department publishes its coverage footprint only in a map viewer,
	// so no coverage row may support a claim that a location is unrestricted.
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

	assertNoCellsFinerThanIndex(cellResolutions, indexResolution, `zoning reader: ${databasePath}`)

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

	// The layer stores no coverage resolution, so it is recovered from the coverage cells.
	// A short cell expands to a valid index at exactly one resolution,
	// and the helper throws on mixed resolutions.
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
