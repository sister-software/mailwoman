/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The `soil.db` reader — what the soil survey assigns at a coordinate, and on what basis.
 *
 *   THREE ANSWERS, AND KEEPING THEM APART IS THE WHOLE JOB.
 *
 *   1. `designated` — the survey mapped this location and the cell's class distribution is the answer.
 *   2. `designated_no_rating` — the survey mapped this location and rated nothing there. A cell that is
 *      100% `unrated_share` or `notrateable_share` is `designated`-complete and carries no capability
 *      reading whatsoever, and that is not a corner case: 17.1% of national components carry no capability
 *      rating.
 *   3. `unknown` — no coverage row. Outside any published survey area, or inside one where the polygon
 *      exists and the soil mapping behind it does not.
 *
 *   READINGS 2 AND 3 LOOK THE SAME FROM A CLASS CODE AND ARE OPPOSITE ANSWERS FROM THE READER. A layer that
 *   could not tell them apart would report unmapped ground as unrated ground, which is one of the four
 *   absences this whole layer exists to keep separate.
 *
 *   THE ANSWER IS A DISTRIBUTION, AND THE TOP CLASS ALWAYS ARRIVES WITH THE SHARE IT RESTS ON. NRCS's own
 *   `muaggatt` ships `niccdcd` beside `niccdcdpct` for exactly this reason, with an observed minimum of 2%.
 *   A caller that wants one class may take `topClass`; it cannot take it without also being handed
 *   `topClassShare`, because a 2% plurality and an 85% majority are different claims.
 *
 *   NEITHER READING IS A STATEMENT ABOUT WHETHER THE LAND CAN BE FARMED. The layer reports what the soil
 *   survey assigns to the map unit covering a location, which is a fact about the map. NRCS states that its
 *   data "do not eliminate the need for onsite sampling, testing, and detailed study of specific sites for
 *   intensive uses" and are "intended for planning purposes only" — so `limits` carries the authority's own
 *   exclusions on every answer.
 *
 *   THE PROBE IS ONE PRIMARY-KEY READ. The reduction is single-resolution and one row per cell, which is
 *   what makes it the spine key: a coordinate becomes a cell, the cell becomes a row, and the geometry tier
 *   underneath is never touched at read time. The unsimplified rings are there for a caller that wants to
 *   re-derive the claim, not for the probe.
 *
 *   THE READER IS SYNCHRONOUS AND USES RAW PREPARED STATEMENTS, matching the resolution ladder's existing
 *   shape. The DDL that created these tables IS Kysely — see `schema.ts`.
 */

import {
	singleManifestRow,
	toCoverageCell,
	toLayerManifest,
	type CoverageRow,
	type CoverageCell,
	type LayerManifest,
} from "@mailwoman/core/layers"
import { parseJSONStrict } from "@mailwoman/core/objects"
import { DatabaseSync } from "@mailwoman/platform/sqlite"
import { shortCellToInt, type H3Cell } from "@mailwoman/spatial"
import { cellToParent, latLngToCell } from "h3-js"

import { SOIL_LAYER_NAME_PREFIX, SSURGO_PRODUCT_LIMITS } from "./vocabulary.ts"

export { FarmlandScope, farmlandScope, SSURGO_PRODUCT_LIMITS } from "./vocabulary.ts"

/**
 * What the layer can say about a coordinate.
 */
export const SoilReadingKind = {
	/**
	 * The survey mapped this location and assigns at least one capability class here.
	 */
	Designated: "designated",
	/**
	 * The survey mapped this location and rated nothing here — every share is an absence share.
	 */
	DesignatedNoRating: "designated_no_rating",
	/**
	 * No coverage row. Unmapped by this authority, and never a low-capability reading.
	 */
	Unknown: "unknown",
} as const

export type SoilReadingKind = (typeof SoilReadingKind)[keyof typeof SoilReadingKind]

/**
 * The per-cell distribution, as a caller reads it.
 */
export interface SoilCapabilityDistribution {
	/**
	 * The authority's class codes mapped to their area-weighted share, largest first.
	 */
	classShares: Record<string, number>
	/**
	 * Mapped soil components carrying a NULL rating — the survey did not rate them.
	 */
	unratedShare: number
	/**
	 * Miscellaneous areas the rating does not apply to.
	 */
	notRateableShare: number
	/**
	 * Polygons with no soil mapping behind them.
	 */
	noDataShare: number
	/**
	 * The truncated minority tail. The five shares sum to 1.
	 */
	otherShare: number
	/**
	 * How much of the cell any delineation covers. Below 1 at a survey-area edge.
	 */
	mappedShare: number
	/**
	 * The largest class share, and the share it rests on. Absent when the cell carries no class at all.
	 */
	topClass?: string
	topClassShare?: number
	/**
	 * Which weighting produced these shares.
	 */
	weighting: string
	/**
	 * How many delineations reached the cell.
	 */
	delineations: number
}

/**
 * One survey area, as the layer holds it.
 */
export interface SoilSurveyAreaRecord {
	areaSymbol: string
	areaName: string
	/**
	 * The refresh — when this version of the data was established.
	 */
	saverest: string
	/**
	 * The FIELD survey date, which is a different fact and is usually much older.
	 */
	surveySourceDate: string | null
	surveySourceTitle: string | null
	sourceScale: number | null
	mappingScale: number | null
}

/**
 * One reading, carrying everything a caller needs to re-derive it rather than take it.
 */
export interface SoilCapabilityReading {
	kind: SoilReadingKind
	/**
	 * The cell's distribution. Present on both designated readings; absent on `unknown`.
	 */
	distribution?: SoilCapabilityDistribution
	/**
	 * The authority's own definition of the top class, from the domain it shipped.
	 */
	topClassDefinition?: string
	/**
	 * The survey area covering the location, with both its dates.
	 */
	surveyArea?: SoilSurveyAreaRecord
	/**
	 * The coverage row that licenses the reading, when there is one. Absent on `unknown`, which IS the absence.
	 */
	coverage?: CoverageCell & { h3CellIndex: string; resolution: number }
	/**
	 * The index cell probed, for a receipt.
	 */
	indexCellIndex: string
	/**
	 * What the product does not cover, in the authority's own words. Carried on every reading.
	 */
	limits: ReadonlyArray<string>
}

/**
 * The layer's identity, read once at open time.
 */
export interface SoilLayerIdentity {
	manifest: LayerManifest
	indexResolution: number
	coverageResolution: number
	/**
	 * The survey areas the layer covers, in symbol order.
	 */
	surveyAreas: SoilSurveyAreaRecord[]
	/**
	 * The class codes the layer's own vocabulary declares.
	 */
	classCodes: string[]
	/**
	 * The weighting every stored share was produced under, and the sentence that says what it means.
	 */
	weighting: { code: string; description: string }
	databasePath: string
}

export interface SoilCapabilityLookupOptions {
	databasePath: string
}

/**
 * Read a sealed `soil.db`.
 *
 * Everything that would make the reader answer a well-formed wrong thing is refused at CONSTRUCTION rather than at
 * query time: a manifest naming a different product, a coverage table with no rows, a vocabulary with no classes. Each
 * of those would otherwise present as a reader that simply always answers `unknown`, which on a receipt is
 * indistinguishable from a region the authority genuinely has not surveyed.
 */
export class SoilCapabilityLookup {
	readonly identity: SoilLayerIdentity

	readonly #database: DatabaseSync
	readonly #selectCell: ReturnType<DatabaseSync["prepare"]>
	readonly #selectCoverage: ReturnType<DatabaseSync["prepare"]>
	readonly #definitions: Map<string, string>
	readonly #surveyAreaByBounds: SoilSurveyAreaRecord[]
	readonly #bounds: Array<{ minLat: number; minLon: number; maxLat: number; maxLon: number }>

	constructor(options: SoilCapabilityLookupOptions) {
		this.#database = new DatabaseSync(options.databasePath, { readOnly: true })

		try {
			const identity = readIdentity(this.#database, options.databasePath)

			this.identity = identity.identity
			this.#definitions = identity.definitions
			this.#surveyAreaByBounds = identity.identity.surveyAreas
			this.#bounds = identity.bounds
		} catch (error) {
			this.#database.close()

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
	 * What the soil survey assigns at this coordinate.
	 */
	public lookup(latitude: number, longitude: number): SoilCapabilityReading {
		const indexCell = latLngToCell(latitude, longitude, this.identity.indexResolution) as H3Cell
		const coverage = this.#readCoverage(indexCell)

		// COVERAGE QUALIFIES THE READING, and without it there is nothing to report. Unlike a polygon hit — which is a
		// determination at a location and needs no coverage row to be true — every answer this layer gives is a per-cell
		// summary, so a summary row without a coverage row would state a determination outside the authority's footprint.
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
			// A coverage row without a summary row means the coverage cell is designated and this finer cell holds nothing —
			// the survey-area edge. Unknown rather than "no rating": the authority's statement covers the coverage cell, and
			// this location may be outside the delineations it covers.
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
	 * Which survey area a coordinate falls in, by the delineation bounds each area's row carries.
	 *
	 * A rectangle rather than the outline, and that is honest about what it is: the answer names WHICH published survey
	 * the reading came from, and two neighbouring counties' rectangles overlap at their corners. The reading itself does
	 * not depend on it — the cell row is the answer — so a corner ambiguity costs a label rather than a determination.
	 *
	 * A LINEAR SCAN, WHICH THE PILOT'S 99 SURVEY AREAS MAKE FREE AND A NATIONAL BUILD WOULD NOT. It returns on the first
	 * containing rectangle, so the pilot costs a few dozen comparisons per geocode. At the 3,380 survey areas the country
	 * holds this wants a bounding-box index; it is left as a scan because a structure sized for a set this build does not
	 * hold would be untested at the size it was built for.
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
 * Read and check the layer's identity.
 */
function readIdentity(
	database: DatabaseSync,
	databasePath: string
): {
	identity: SoilLayerIdentity
	definitions: Map<string, string>
	bounds: Array<{ minLat: number; minLon: number; maxLat: number; maxLon: number }>
} {
	const manifestRows = database.prepare("SELECT * FROM layer_manifest").all() as Array<
		Record<string, string | number | null>
	>

	// The name's SUFFIX names the region a build covers, so the reader checks the prefix rather than a whole name — which
	// is why it asserts its own identity instead of taking `parseManifestRows`: one authority, one product, one rating
	// vocabulary per artifact, over whichever survey areas were built.
	const row = singleManifestRow(manifestRows, `soil reader: ${databasePath}`)
	const name = String(row.name)

	if (!name.startsWith(SOIL_LAYER_NAME_PREFIX)) {
		throw new Error(
			`soil reader: ${databasePath} is layer ${JSON.stringify(name)}, which is not a ${JSON.stringify(SOIL_LAYER_NAME_PREFIX)} layer — one authority, one product, one rating vocabulary per artifact`
		)
	}

	const manifest = toLayerManifest(row)
	const spineKeys = manifest.spineKeys

	if (!spineKeys.h3) {
		throw new Error(`soil reader: ${databasePath} declares no h3 spine key`)
	}

	const coverageCount = (database.prepare("SELECT count(*) AS n FROM layer_coverage").get() as { n: number }).n

	if (!coverageCount) {
		throw new Error(
			`soil reader: ${databasePath} holds no coverage rows — every location would read as unknown, which is indistinguishable from a region the authority has not surveyed`
		)
	}

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
			databasePath,
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
