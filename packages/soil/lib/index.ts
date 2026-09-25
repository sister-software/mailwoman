/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Synchronous reader for `soil.db` that returns the soil survey's capability-class distribution at a coordinate.
 */

import { parseJSONStrict, stringifyJSON } from "@mailwoman/core/json"
import {
	assertCoverageNotEmpty,
	singleManifestRow,
	toLayerManifest,
	type CoverageCell,
	type LayerManifest,
} from "@mailwoman/core/layers"
import { shortCellToInt, type H3Cell } from "@mailwoman/spatial"
import { readCoverageAt } from "@mailwoman/spatial/h3/coverage"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { latLngToCell } from "h3-js"
import type { PathBuilderLike } from "path-ts"

import type { SoilDatabase } from "#schema"
import { SOIL_LAYER_NAME_PREFIX, SSURGO_PRODUCT_LIMITS } from "#vocabulary"

export { FarmlandScope, farmlandScope, SSURGO_PRODUCT_LIMITS } from "#vocabulary"

/**
 * The kinds of answer the layer gives for a coordinate.
 *
 * A caller must keep `DesignatedNoRating` and `Unknown` apart.
 * The first means the survey mapped the location and rated nothing.
 *
 * The second means the layer has no survey data for the location.
 */
export const SoilReadingKind = {
	/**
	 * The survey mapped this location and assigns at least one capability class.
	 */
	Designated: "designated",
	/**
	 * The survey mapped this location and rated nothing.
	 * Every share is an absence share.
	 */
	DesignatedNoRating: "designated_no_rating",
	/**
	 * The layer has no coverage for this location.
	 * This kind never implies low capability.
	 */
	Unknown: "unknown",
} as const

/**
 * One of the {@link SoilReadingKind} values.
 */
export type SoilReadingKind = (typeof SoilReadingKind)[keyof typeof SoilReadingKind]

/**
 * The capability-class distribution of one cell.
 */
export interface SoilCapabilityDistribution {
	/**
	 * The authority's class codes mapped to their area-weighted shares, largest first.
	 */
	classShares: Record<string, number>
	/**
	 * The share of mapped soil components that have a NULL rating.
	 */
	unratedShare: number
	/**
	 * The share of miscellaneous areas that the rating does not apply to.
	 */
	notRateableShare: number
	/**
	 * The share of polygons that have no soil mapping.
	 */
	noDataShare: number
	/**
	 * The share of the truncated minority classes.
	 *
	 * The class shares and the four other shares sum to 1.
	 */
	otherShare: number
	/**
	 * The fraction of the cell that any delineation covers.
	 * It is below 1 at a survey-area edge.
	 */
	mappedShare: number
	/**
	 * The class with the largest share, and that share.
	 *
	 * Both fields are absent when the cell has no class.
	 * A caller that reads `topClass` should also report `topClassShare`,
	 * because the top class can hold a small plurality.
	 */
	topClass?: string
	topClassShare?: number
	/**
	 * The weighting that produced these shares.
	 */
	weighting: string
	/**
	 * The number of delineations that reached the cell.
	 */
	delineations: number
}

/**
 * One survey area in the layer.
 */
export interface SoilSurveyAreaRecord {
	areaSymbol: string
	areaName: string
	/**
	 * The date on which this version of the survey data was established.
	 */
	saverest: string
	/**
	 * The field survey date, which is usually much older than `saverest`.
	 */
	surveySourceDate: string | null
	surveySourceTitle: string | null
	sourceScale: number | null
	mappingScale: number | null
}

/**
 * One reading at a coordinate, with the provenance a caller needs to check it.
 */
export interface SoilCapabilityReading {
	kind: SoilReadingKind
	/**
	 * The cell's distribution.
	 *
	 * It is present on both designated kinds and absent on `unknown`.
	 */
	distribution?: SoilCapabilityDistribution
	/**
	 * The authority's definition of the top class, from its vocabulary.
	 */
	topClassDefinition?: string
	/**
	 * The survey area that covers the location.
	 */
	surveyArea?: SoilSurveyAreaRecord
	/**
	 * The coverage row that supports the reading, when one exists.
	 */
	coverage?: CoverageCell & { h3CellIndex: string; resolution: number }
	/**
	 * The H3 index cell that the lookup probed.
	 */
	indexCellIndex: string
	/**
	 * The authority's own statements of what the product does not cover.
	 *
	 * Every reading includes them because the survey supports planning only
	 * and does not replace onsite study.
	 */
	limits: ReadonlyArray<string>
}

/**
 * The layer's identity, read once when the database opens.
 */
export interface SoilLayerIdentity {
	manifest: LayerManifest
	indexResolution: number
	coverageResolution: number
	/**
	 * The survey areas the layer covers, ordered by area symbol.
	 */
	surveyAreas: SoilSurveyAreaRecord[]
	/**
	 * The class codes that the layer's vocabulary declares.
	 */
	classCodes: string[]
	/**
	 * The code of the weighting used for every stored share, with its description.
	 */
	weighting: { code: string; description: string }
	databasePath: string
}

/**
 * Options for {@link SoilCapabilityLookup}.
 */
export interface SoilCapabilityLookupOptions {
	databasePath: PathBuilderLike
}

/**
 * Reads a sealed `soil.db`.
 *
 * The constructor throws on a manifest for a different product, an empty coverage table, an empty
 * class vocabulary or a missing share weighting. Each of these would otherwise make every lookup
 * return `unknown`, which looks the same as a region the authority has not surveyed.
 */
export class SoilCapabilityLookup implements Disposable {
	readonly identity: SoilLayerIdentity

	readonly #database: DatabaseClient<SoilDatabase>
	readonly #selectCell: ReturnType<DatabaseClient["prepare"]>
	readonly #selectCoverage: ReturnType<DatabaseClient["prepare"]>
	readonly #definitions: Map<string, string>
	readonly #surveyAreaByBounds: SoilSurveyAreaRecord[]
	readonly #bounds: Array<{ minLat: number; minLon: number; maxLat: number; maxLon: number }>

	constructor(options: SoilCapabilityLookupOptions) {
		this.#database = new DatabaseClient<SoilDatabase>(options.databasePath, { readOnly: true })

		try {
			const identity = readIdentity(this.#database, options.databasePath)

			this.identity = identity.identity
			this.#definitions = identity.definitions
			this.#surveyAreaByBounds = identity.identity.surveyAreas
			this.#bounds = identity.bounds
		} catch (error) {
			this.#database.destroy()

			throw error
		}

		this.#selectCell = this.#database.prepare(
			"SELECT class_shares, unrated_share, notrateable_share, nodata_share, other_share, mapped_share, top_class, top_class_share, weighting, delineations FROM soil_capability_cell WHERE h3_cell = ?"
		)

		this.#selectCoverage = this.#database.prepare(
			"SELECT h3_cell, completeness, basis, observed_rows FROM layer_coverage WHERE h3_cell = ?"
		)
	}

	/**
	 * Returns what the soil survey assigns at this coordinate.
	 */
	public lookup(latitude: number, longitude: number): SoilCapabilityReading {
		const indexCell = latLngToCell(latitude, longitude, this.identity.indexResolution) as H3Cell
		const coverage = this.#readCoverage(indexCell)

		// Every answer is a per-cell summary, so a cell outside the coverage table
		// is unknown even if a summary row exists.
		if (!coverage) {
			return {
				kind: SoilReadingKind.Unknown,
				indexCellIndex: indexCell,
				limits: SSURGO_PRODUCT_LIMITS,
			}
		}

		const row = this.#selectCell.get(shortCellToInt(indexCell)) as
			| {
					class_shares: string
					unrated_share: number
					notrateable_share: number
					nodata_share: number
					other_share: number
					mapped_share: number
					top_class: string | null
					top_class_share: number | null
					weighting: string
					delineations: number
			  }
			| undefined

		if (!row) {
			// This happens at a survey-area edge, where the coarser coverage cell is covered
			// and this index cell has no delineation.
			// The location may be outside the survey, so the answer is unknown.
			return {
				kind: SoilReadingKind.Unknown,
				coverage,
				indexCellIndex: indexCell,
				limits: SSURGO_PRODUCT_LIMITS,
			}
		}

		const distribution: SoilCapabilityDistribution = {
			classShares: parseJSONStrict<Record<string, number>>(row.class_shares),
			unratedShare: row.unrated_share,
			notRateableShare: row.notrateable_share,
			noDataShare: row.nodata_share,
			otherShare: row.other_share,
			mappedShare: row.mapped_share,
			...(row.top_class ? { topClass: row.top_class } : {}),
			...(row.top_class_share === null ? {} : { topClassShare: row.top_class_share }),
			weighting: row.weighting,
			delineations: row.delineations,
		}

		const surveyArea = this.#surveyAreaAt(latitude, longitude)
		const definition = row.top_class ? this.#definitions.get(row.top_class) : undefined

		return {
			kind: row.top_class ? SoilReadingKind.Designated : SoilReadingKind.DesignatedNoRating,
			distribution,
			...(definition ? { topClassDefinition: definition } : {}),
			...(surveyArea ? { surveyArea } : {}),
			coverage,
			indexCellIndex: indexCell,
			limits: SSURGO_PRODUCT_LIMITS,
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
	 * Returns the first survey area whose bounding rectangle contains the coordinate.
	 *
	 * Neighbouring areas' rectangles can overlap, so the result may be the wrong area near a corner.
	 * This affects only the `surveyArea` label, because the distribution comes from the cell row.
	 *
	 * The search is a linear scan.
	 * A build with thousands of survey areas would need a spatial index.
	 */
	#surveyAreaAt(latitude: number, longitude: number): SoilSurveyAreaRecord | undefined {
		for (const [index, bounds] of this.#bounds.entries()) {
			if (
				longitude >= bounds.minLon &&
				longitude <= bounds.maxLon &&
				latitude >= bounds.minLat &&
				latitude <= bounds.maxLat
			) {
				return this.#surveyAreaByBounds[index]
			}
		}

		return undefined
	}
}

/**
 * Reads the layer's identity and throws if it is unusable.
 */
function readIdentity(
	database: DatabaseClient<SoilDatabase>,
	databasePath: PathBuilderLike
): {
	identity: SoilLayerIdentity
	definitions: Map<string, string>
	bounds: Array<{ minLat: number; minLon: number; maxLat: number; maxLon: number }>
} {
	const manifestRows = database.prepare("SELECT * FROM layer_manifest").all() as Array<
		Record<string, string | number | null>
	>

	// The layer name ends with the region that the build covers, so the reader checks only the prefix.
	// It does its own check instead of using `parseManifestRows`, which compares whole names.
	const row = singleManifestRow(manifestRows, `soil reader: ${databasePath}`)
	const name = String(row.name)

	if (!name.startsWith(SOIL_LAYER_NAME_PREFIX)) {
		throw new Error(
			`soil reader: ${databasePath} is layer ${stringifyJSON(name)}, which is not a ${stringifyJSON(SOIL_LAYER_NAME_PREFIX)} layer — one authority, one product, one rating vocabulary per artifact`
		)
	}

	const manifest = toLayerManifest(row)
	const spineKeys = manifest.spineKeys

	if (!spineKeys.h3) {
		throw new Error(`soil reader: ${databasePath} declares no h3 spine key`)
	}

	const coverageCount = (database.prepare("SELECT count(*) AS n FROM layer_coverage").get() as { n: number }).n

	assertCoverageNotEmpty(coverageCount, `soil reader: ${databasePath}`, "a region the authority has not surveyed")

	const areaRows = database
		.prepare(
			"SELECT areasymbol, areaname, saverest, survey_source_date, survey_source_title, source_scale, mapping_scale, min_lat, min_lon, max_lat, max_lon, coverage_resolution FROM soil_survey_area ORDER BY areasymbol"
		)
		.all() as Array<{
		areasymbol: string
		areaname: string
		saverest: string
		survey_source_date: string | null
		survey_source_title: string | null
		source_scale: number | null
		mapping_scale: number | null
		min_lat: number
		min_lon: number
		max_lat: number
		max_lon: number
		coverage_resolution: number
	}>

	if (!areaRows.length) {
		throw new Error(
			`soil reader: ${databasePath} names no survey area — the footprint is the claim, and an artifact that cannot name which surveys it holds cannot support one`
		)
	}

	const coverageResolutions = new Set(areaRows.map((area) => area.coverage_resolution))

	if (coverageResolutions.size !== 1) {
		throw new Error(
			`soil reader: ${databasePath}'s survey areas declare coverage resolutions ${[...coverageResolutions].join(", ")} — a probe derives its coverage cell from one resolution, and a mixed table would answer some locations from the wrong parent`
		)
	}

	const definitions = new Map<string, string>()

	for (const vocabularyRow of database
		.prepare("SELECT code, definition FROM soil_vocabulary WHERE domain = 'capability_class' ORDER BY sequence")
		.all() as Array<{ code: string; definition: string }>) {
		definitions.set(vocabularyRow.code, vocabularyRow.definition)
	}

	if (!definitions.size) {
		throw new Error(
			`soil reader: ${databasePath} declares no capability-class vocabulary — an answer could not be checked against the authority's own domain`
		)
	}

	const weighting = database
		.prepare("SELECT code, definition FROM soil_vocabulary WHERE domain = 'share_weighting'")
		.get() as { code: string; definition: string } | undefined

	if (!weighting) {
		throw new Error(
			`soil reader: ${databasePath} records no share weighting — the shares would arrive without the one fact needed to know what they are shares OF`
		)
	}

	return {
		identity: {
			manifest,
			indexResolution: spineKeys.h3.resolution,
			coverageResolution: [...coverageResolutions][0]!,
			surveyAreas: areaRows.map((area) => ({
				areaSymbol: area.areasymbol,
				areaName: area.areaname,
				saverest: area.saverest,
				surveySourceDate: area.survey_source_date,
				surveySourceTitle: area.survey_source_title,
				sourceScale: area.source_scale,
				mappingScale: area.mapping_scale,
			})),
			classCodes: [...definitions.keys()],
			weighting: { code: weighting.code, description: weighting.definition },
			databasePath: databasePath.toString(),
		},
		definitions,
		bounds: areaRows.map((area) => ({
			minLat: area.min_lat,
			minLon: area.min_lon,
			maxLat: area.max_lat,
			maxLon: area.max_lon,
		})),
	}
}
