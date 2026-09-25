/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Builds the sealed `soil.db` polygon layer from NRCS soil survey areas.
 *
 *   The builder streams cell touches into a temporary SQL table so that memory stays flat as the row
 *   count grows. Absent data has no row in any table. Land outside a survey area, and coverage cells that
 *   only `notcom` or access-denied polygons reach, get no coverage row.
 */

import { readFileSize } from "@mailwoman/core/fs/readers"
import {
	areaAgreementFrom,
	createLayerCoverageTable,
	createLayerManifestTable,
	designatedCoverageCells,
	polygonLayerManifest,
	writeLayerCoverage,
	writeLayerManifest,
	type AreaAgreementReading,
	type CoverageCell,
} from "@mailwoman/core/layers"
import { resolveModulePath } from "@mailwoman/core/module/resolvers"
import { ingestChunkArguments, mergeCountsInto, runChunkProcess } from "@mailwoman/core/utils"
import {
	arealPolygons,
	geometryContains,
	interiorCoverageCells,
	shortCellToInt,
	type MultiPolygonRings,
	type ParsedGeometry,
} from "@mailwoman/spatial"
import type { DatabaseClient } from "@mailwoman/sqlite/client"
import { buildSealedArtifact } from "@mailwoman/sqlite/sealed-build"
import { cellToLatLng } from "h3-js"
import type { PathBuilderLike } from "path-ts"

import { createSoilTables, type SoilDatabase, type SoilSurveyAreaTable } from "#schema"
import { reduceCells, resolveCells } from "#sdk/cell-tiers"
import type { SoilChunkResult } from "#sdk/ingest/chunk"
import { ingestSoilChunk } from "#sdk/ingest/chunk"
import type { SoilFeatureSource } from "#sdk/ingest/index"
import { WEIGHT_LATTICE_DEPTH } from "#sdk/reduce"
import type { SurveyAreaAttributes } from "#sdk/survey-area"
import {
	SOIL_SHARE_WEIGHTING,
	SOIL_SHARE_WEIGHTING_DESCRIPTION,
	soilLayerName,
	SSURGO_ATTRIBUTION,
	SSURGO_LICENSE,
	SSURGO_SOURCE,
} from "#vocabulary"

/**
 * The schema version of the domain tables.
 *
 * It changes when a column changes meaning.
 * An added column that readers can ignore does not change it.
 */
export const SOIL_SCHEMA_VERSION = 1

/**
 * The number of delineation ids per chunk process.
 *
 * A single process over a large polygon layer fails after several hundred thousand
 * features because the h3 wasm heap fragments.
 * This size stays well below that limit.
 */
export const DEFAULT_CHUNK_SIZE = 100_000

/**
 * Square metres per acre, the unit of `legend.areaacres`.
 */
const M2_PER_ACRE = 4046.8564224

/**
 * The relative gap between the ring-area total and the published acreage above which the build fails.
 *
 * NRCS warns that its acreage can differ from a GIS measurement, so an exact
 * comparison would fail on valid data.
 * A hole read as an exterior ring produces a much larger gap than this tolerance.
 */
const AREA_TOLERANCE = 0.02

/**
 * One survey area ready to build, with its geometry and tabular attributes.
 */
export interface SurveyAreaInput {
	attributes: SurveyAreaAttributes
	/**
	 * The path of the map-unit polygon shapefile.
	 */
	shapefilePath?: string
	/**
	 * The survey area's outline.
	 */
	outline: ParsedGeometry
	/**
	 * An in-process feature source, used by fixtures.
	 *
	 * The batched path builds one of these per chunk, so both paths share one implementation.
	 */
	source?: SoilFeatureSource
	/**
	 * The delineation count that the shapefile declares, when the caller has already read it.
	 */
	declaredFeatureCount?: number
}

/**
 * Options for {@link buildSoilDatabase}.
 */
export interface BuildSoilOptions {
	/**
	 * The survey areas to build, in ingest order.
	 */
	areas: ReadonlyArray<SurveyAreaInput>
	/**
	 * The region code in the layer name, such as `ia`.
	 */
	region: string
	/**
	 * The path of the sealed artifact.
	 *
	 * The build writes a temporary file beside it and then swaps it in.
	 */
	out: PathBuilderLike
	/**
	 * The survey refresh date, written to `layer_manifest.version` and `source_vintage`.
	 */
	sourceVintage: string
	buildCmd: string
	buildSHA: string
	/**
	 * The ISO-8601 creation time, supplied by the caller so that two builds of the same inputs are identical.
	 */
	createdAt: string
	/**
	 * The H3 resolution of the cell index and the reduction.
	 */
	indexResolution: number
	/**
	 * The H3 resolution of the `layer_coverage` rows.
	 * It must be coarser than the index resolution.
	 */
	coverageResolution: number
	/**
	 * The number of delineation ids per chunk process.
	 * See {@link DEFAULT_CHUNK_SIZE}.
	 */
	chunkSize?: number
	/**
	 * Whether to run the ingest in this process instead of in chunk processes.
	 *
	 * Only fixtures use it, because they have no shapefile for a child process to open.
	 */
	inProcess?: boolean
	onProgress?: (message: string) => void
}

/**
 * The counts and measurements that {@link buildSoilDatabase} reports.
 */
export interface BuildSoilResult {
	out: string
	region: string
	surveyAreas: number
	delineations: number
	mapUnits: number
	components: number
	indexResolution: number
	coverageResolution: number
	wholeCellRows: number
	partialCellRows: number
	/**
	 * The value of `partialCellRows / (wholeCellRows + partialCellRows)` over the stored index rows.
	 *
	 * Whole cells are compacted, so this differs from the partial share used to choose the resolution.
	 */
	storedPartialShare: number
	capabilityCells: number
	/**
	 * The number of cells reduced with the sampling lattice instead of the whole-cell fast path.
	 */
	sampledCells: number
	/**
	 * The number of cells whose top class covers less than half the cell.
	 */
	topClassUnderHalfCells: number
	topClassUnderHalfShare: number
	/**
	 * The number of cells that the survey mapped but did not rate.
	 */
	classlessCells: number
	/**
	 * The number of indexed cells that no lattice point landed in.
	 *
	 * These cells are dropped.
	 * A large count means the lattice is too coarse for the geometry.
	 */
	unsampledCells: number
	meanDelineationsPerCell: number
	coarsenedFeatures: number
	storedResolutions: number[]
	coverageCells: number
	/**
	 * The number of coverage cells inside a survey-area outline that no mapped delineation reached.
	 *
	 * SSURGO covers every part of a published area, so a large count means the outline
	 * and the delineations disagree.
	 */
	coverageCellsWithoutMapping: number
	/**
	 * The ring-area totals in square kilometres, compared with the published acreage.
	 *
	 * Its `known` count is the number of survey areas that publish an acreage.
	 */
	area: AreaAgreementReading
	sizeBytes: number
}

/**
 * Builds the soil layer.
 *
 * @throws {Error} When the classifier rejects a delineation, when a streamed count
 * differs from the shapefile's declared count, when the area total differs from the
 * published acreage, or when the outlines contain no interior coverage cell.
 */
export async function buildSoilDatabase(options: BuildSoilOptions): Promise<BuildSoilResult> {
	if (options.coverageResolution >= options.indexResolution) {
		throw new Error(
			`soil build: the coverage resolution (${options.coverageResolution}) must be coarser than the index resolution (${options.indexResolution}) — a row's coverage cell is the PARENT of its index cell`
		)
	}

	if (!options.areas.length) {
		throw new Error(
			"soil build: no survey areas were supplied — an empty build writes an artifact that answers unknown everywhere while reporting success"
		)
	}

	const built = await buildSealedArtifact<SoilDatabase, StreamResult, Omit<BuildSoilResult, "sizeBytes">>({
		out: options.out,
		createTables: async (kdb) => {
			await createSoilTables(kdb)
			await createLayerManifestTable(kdb)
			await createLayerCoverageTable(kdb)

			// The touch table is dropped before the artifact is sealed.
			// It has no primary key because a clustered key would sort every insert.
			// The resolution queries use indexes that are created after the load.
			kdb.exec(
				"CREATE TABLE build_cell_touch (h3_cell INTEGER NOT NULL, resolution INTEGER NOT NULL, area_id TEXT NOT NULL, is_full INTEGER NOT NULL)"
			)
		},
		ingest: async (kdb) => {
			// The attributes are written first because the ingest needs the map units that have no soil mapping.
			// Writing them first also makes a delineation with a missing map unit fail early.
			writeAttributes(kdb, options.areas)

			if (!options.inProcess) return undefined

			return aggregateChunks(await ingestInProcess(kdb, options))
		},
		...(options.inProcess
			? {}
			: { batched: async (tmpPath: string) => aggregateChunks(await runBatchedIngest(tmpPath, options)) }),
		finish: async (kdb, ingested) => {
			assertDelineationCounts(options.areas, ingested)
			const area = assertAreaAgreement(options.areas, ingested)

			options.onProgress?.(`${ingested.delineations.toLocaleString()} delineations written · resolving cells`)

			const cells = resolveCells(kdb, options.indexResolution)

			options.onProgress?.(
				`${cells.wholeRows.toLocaleString()} whole (compacted) · ${cells.partialRows.toLocaleString()} partial · reducing`
			)

			const reduced = reduceCells(kdb, options.indexResolution, options.onProgress)

			const coverage = buildCoverageCells(options, ingested)

			await writeLayerCoverage(kdb, coverage.cells)

			writeSurveyAreaRows(kdb, options, coverage.cellsByArea)
			writeVocabularyRows(kdb, options.areas)

			// The spine key is the column that consumers join on.
			// It points at `soil_capability_cell`, which has one row per cell at one resolution.
			// The `soil_map_unit_cell` table is keyed by cell and delineation at mixed
			// resolutions, so consumers cannot join on it.
			await writeLayerManifest(
				kdb,
				polygonLayerManifest(options, {
					name: soilLayerName(options.region),
					schemaVersion: SOIL_SCHEMA_VERSION,
					license: SSURGO_LICENSE,
					attribution: SSURGO_ATTRIBUTION,
					source: SSURGO_SOURCE,
					cellColumn: "soil_capability_cell.h3_cell",
				})
			)

			kdb.exec("DROP TABLE build_cell_touch")

			const totalCellRows = cells.wholeRows + cells.partialRows

			return {
				out: options.out.toString(),
				region: options.region,
				surveyAreas: options.areas.length,
				delineations: ingested.delineations,
				mapUnits: options.areas.reduce((sum, input) => sum + input.attributes.mapUnits.length, 0),
				components: options.areas.reduce((sum, input) => sum + input.attributes.components.length, 0),
				indexResolution: options.indexResolution,
				coverageResolution: options.coverageResolution,
				wholeCellRows: cells.wholeRows,
				partialCellRows: cells.partialRows,
				storedPartialShare: totalCellRows ? cells.partialRows / totalCellRows : 0,
				capabilityCells: reduced.cells,
				sampledCells: reduced.sampled,
				topClassUnderHalfCells: reduced.topClassUnderHalf,
				topClassUnderHalfShare: reduced.cells ? reduced.topClassUnderHalf / reduced.cells : 0,
				classlessCells: reduced.classless,
				unsampledCells: reduced.unsampled,
				meanDelineationsPerCell: reduced.cells ? reduced.candidatePairs / reduced.cells : 0,
				coarsenedFeatures: ingested.coarsened,
				storedResolutions: cells.resolutions,
				coverageCells: coverage.cells.length,
				coverageCellsWithoutMapping: coverage.withoutMapping,
				area,
			}
		},
	})

	return { ...built, sizeBytes: await readFileSize(options.out) }
}

/**
 * The combined result of every ingest chunk.
 */
interface StreamResult {
	delineations: number
	coarsened: number
	byArea: Map<string, number>
	observedByCoverageCell: Map<number, number>
	mappedByCoverageCell: Map<number, number>
	nestedM2: number
	allExteriorM2: number
}

/**
 * Sums the results of the ingest chunks.
 *
 * It is exported for a unit test because fixture builds do not exercise the batched path.
 */
export function aggregateChunks(chunks: ReadonlyArray<SoilChunkResult>): StreamResult {
	const byArea = new Map<string, number>()
	const observedByCoverageCell = new Map<number, number>()
	const mappedByCoverageCell = new Map<number, number>()

	let delineations = 0
	let coarsened = 0
	let nestedM2 = 0
	let allExteriorM2 = 0

	for (const chunk of chunks) {
		delineations += chunk.delineations
		coarsened += chunk.coarsened
		nestedM2 += chunk.area.nestedM2
		allExteriorM2 += chunk.area.allExteriorM2

		byArea.set(chunk.areaSymbol, (byArea.get(chunk.areaSymbol) ?? 0) + chunk.delineations)

		// One coverage cell can appear in several chunks and in two survey areas, so the counts are summed.
		mergeCountsInto(observedByCoverageCell, chunk.observedByCoverageCell)
		mergeCountsInto(mappedByCoverageCell, chunk.mappedByCoverageCell)
	}

	return { delineations, coarsened, byArea, observedByCoverageCell, mappedByCoverageCell, nestedM2, allExteriorM2 }
}

/**
 * Throws when the streamed delineation count of a survey area differs from its declared count.
 */
function assertDelineationCounts(areas: ReadonlyArray<SurveyAreaInput>, streamed: StreamResult): void {
	for (const area of areas) {
		const declared = area.declaredFeatureCount ?? area.source?.declaredFeatureCount

		if (declared === undefined) continue

		const actual = streamed.byArea.get(area.attributes.areasymbol) ?? 0

		if (actual !== declared) {
			throw new Error(
				`soil build: ${area.attributes.areasymbol} streamed ${actual} delineations, its shapefile declares ${declared} — a short read builds a smaller survey area and reports success`
			)
		}
	}
}

/**
 * Throws when the ring-area total differs from the published acreage by more than {@link AREA_TOLERANCE}.
 *
 * The error message includes the total with holes ignored, because a hole read
 * as an exterior ring causes the gap.
 * When no survey area publishes an acreage, the check is skipped.
 */
function assertAreaAgreement(areas: ReadonlyArray<SurveyAreaInput>, streamed: StreamResult): AreaAgreementReading {
	let publishedAcres = 0
	let known = 0

	for (const input of areas) {
		if (input.attributes.areaAcres !== null) {
			publishedAcres += input.attributes.areaAcres

			known++
		}
	}

	const area = areaAgreementFrom(
		{ nestedM2: streamed.nestedM2, allExteriorM2: streamed.allExteriorM2 },
		known ? publishedAcres * M2_PER_ACRE : undefined
	)

	if (area.witness === "source" && area.relativeGap > AREA_TOLERANCE) {
		throw new Error(
			`soil build: the encoded rings total ${area.nestedKM2.toFixed(1)} km² against the ${area.sourceKM2.toFixed(1)} km² the authority publishes for these ${known} survey areas ` +
				`(${(area.relativeGap * 100).toFixed(2)}% apart, tolerance ${(AREA_TOLERANCE * 100).toFixed(0)}%). Read without their holes the same rings total ` +
				`${area.allExteriorKM2.toFixed(1)} km², so compare the two: a hole-blind read answers "inside" for every point in a hole`
		)
	}

	return area
}

/**
 * Writes every survey area's map units and components.
 */
function writeAttributes(database: DatabaseClient<SoilDatabase>, areas: ReadonlyArray<SurveyAreaInput>): void {
	const insertMapUnit = database.prepare(
		"INSERT OR REPLACE INTO soil_map_unit (mukey, areasymbol, musym, muname, mukind, mustatus, farmlndcl, farmland_scope, niccdcd, niccdcdpct, no_mapping) " +
			"VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
	)

	const insertComponent = database.prepare(
		"INSERT OR REPLACE INTO soil_component (cokey, mukey, comppct_r, compname, compkind, nirrcapcl, nirrcapscl, irrcapcl, irrcapscl, nccpi_v3) " +
			"VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
	)

	database.exec("BEGIN")

	for (const area of areas) {
		for (const mapUnit of area.attributes.mapUnits) {
			insertMapUnit.run(
				mapUnit.mukey,
				mapUnit.areasymbol,
				mapUnit.musym,
				mapUnit.muname,
				mapUnit.mukind,
				mapUnit.mustatus,
				mapUnit.farmlndcl,
				mapUnit.farmland_scope,
				mapUnit.niccdcd,
				mapUnit.niccdcdpct,
				mapUnit.no_mapping
			)
		}

		for (const component of area.attributes.components) {
			insertComponent.run(
				component.cokey,
				component.mukey,
				component.comppct_r,
				component.compname,
				component.compkind,
				component.nirrcapcl,
				component.nirrcapscl,
				component.irrcapcl,
				component.irrcapscl,
				component.nccpi_v3
			)
		}
	}

	database.exec("COMMIT")
}

/**
 * Returns the keys of the map units that have no soil mapping.
 */
function noMappingMukeys(areas: ReadonlyArray<SurveyAreaInput>): Set<string> {
	const mukeys = new Set<string>()

	for (const area of areas) {
		for (const mapUnit of area.attributes.mapUnits) {
			if (mapUnit.no_mapping) {
				mukeys.add(mapUnit.mukey)
			}
		}
	}

	return mukeys
}

/**
 * Ingests one chunk per survey area in this process.
 * Only fixtures use it.
 */
async function ingestInProcess(
	database: DatabaseClient<SoilDatabase>,
	options: BuildSoilOptions
): Promise<SoilChunkResult[]> {
	const noMapping = noMappingMukeys(options.areas)
	const chunks: SoilChunkResult[] = []

	for (const area of options.areas) {
		if (!area.source) {
			throw new Error(
				`soil build: ${area.attributes.areasymbol} was built in-process without a feature source — the in-process path is for fixtures, which supply one`
			)
		}

		chunks.push(
			await ingestSoilChunk(database, {
				source: area.source,
				indexResolution: options.indexResolution,
				coverageResolution: options.coverageResolution,
				noMappingMukeys: noMapping,
				...(options.onProgress ? { onProgress: options.onProgress } : {}),
			})
		)
	}

	return chunks
}

/**
 * Runs the ingest as a sequence of child processes, one per FID range of one survey area.
 *
 * The shared chunk protocol and its error handling live in `ingestChunkArguments` and `runChunkProcess`.
 */
async function runBatchedIngest(tmpPath: string, options: BuildSoilOptions): Promise<SoilChunkResult[]> {
	const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE
	const script = resolveModulePath("@mailwoman/soil/scripts/ingest-chunk")
	const noMapping = [...noMappingMukeys(options.areas)]
	const chunks: SoilChunkResult[] = []

	for (const area of options.areas) {
		if (!area.shapefilePath) {
			throw new Error(
				`soil build: ${area.attributes.areasymbol} has no shapefile path, so no chunk process can open it`
			)
		}

		const declared = area.declaredFeatureCount ?? 0

		for (let from = 0; from < Math.max(declared, 1); from += chunkSize) {
			const to = Math.min(from + chunkSize - 1, declared - 1)

			options.onProgress?.(`${area.attributes.areasymbol}: FID ${from}–${to}`)

			chunks.push(
				await runChunkProcess<SoilChunkResult>({
					script,
					context: "soil build",
					subject: `chunk ${area.attributes.areasymbol} FID ${from}–${to}`,
					args: ingestChunkArguments({
						database: tmpPath,
						args: [
							"--shapefile",
							area.shapefilePath,
							"--area-symbol",
							area.attributes.areasymbol,
							"--fid-from",
							String(from),
							"--fid-to",
							String(to),
							"--no-mapping-mukeys",
							noMapping.join(","),
						],
						indexResolution: options.indexResolution,
						coverageResolution: options.coverageResolution,
					}),
				})
			)
		}
	}

	return chunks
}

/**
 * Returns one coverage row per interior cell of the built footprint that soil mapping reaches.
 *
 * The interior test keeps only cells that lie wholly inside the footprint.
 * It runs once over the union of all outlines, because running it per survey area
 * would drop every cell that crosses an internal county border.
 *
 * Only cells on the outer border of the built set are dropped.
 *
 * The `observed_rows` column counts the delineations that reach the cell.
 * A cell that only `notcom` and access-denied polygons reach gets no row, because it has no soil mapping.
 */
function buildCoverageCells(
	options: BuildSoilOptions,
	streamed: StreamResult
): { cells: CoverageCell[]; cellsByArea: Map<string, number>; withoutMapping: number } {
	const footprint: ParsedGeometry = {
		type: "MultiPolygon",
		coordinates: options.areas.flatMap((input) => outlinePolygons(input.outline)),
	}

	const interior = interiorCoverageCells(footprint, options.coverageResolution)

	if (!interior.length) {
		throw new Error(
			`soil build: the ${options.areas.length} built outline(s) yield no interior cell at resolution ${options.coverageResolution} — the artifact would carry no coverage rows and answer "unknown" everywhere while reporting success`
		)
	}

	const mapped = (h3Cell: number): boolean => (streamed.mappedByCoverageCell.get(h3Cell) ?? 0) > 0

	const cells = designatedCoverageCells(
		interior.map((cell) => shortCellToInt(cell)),
		streamed.observedByCoverageCell,
		{ include: mapped }
	)

	const cellsByArea = new Map<string, number>()

	let withoutMapping = 0

	for (const cell of interior) {
		if (!mapped(shortCellToInt(cell))) {
			withoutMapping++

			continue
		}

		// The cell's centre decides its survey area, so each cell counts for one area only.
		// This per-area count is informational and does not affect the coverage rows.
		const [latitude, longitude] = cellToLatLng(cell)
		const owner = options.areas.find((input) => geometryContains(input.outline, longitude, latitude))

		if (owner) {
			const symbol = owner.attributes.areasymbol

			cellsByArea.set(symbol, (cellsByArea.get(symbol) ?? 0) + 1)
		}
	}

	return { cells, cellsByArea, withoutMapping }
}

/**
 * Returns an outline's polygons in `MultiPolygon` coordinate form.
 *
 * @throws {TypeError} When the outline is not a polygon or multipolygon.
 * Skipping it would silently drop that survey area's coverage.
 */
function outlinePolygons(outline: ParsedGeometry): MultiPolygonRings {
	const polygons = arealPolygons(outline)

	if (polygons) return polygons

	throw new TypeError(
		`soil build: a survey-area outline is a ${outline.type}, which bounds no area — its coverage would be silently absent rather than refused`
	)
}

/**
 * Inserts one row per survey area.
 */
function writeSurveyAreaRows(
	database: DatabaseClient<SoilDatabase>,
	options: BuildSoilOptions,
	cellsByArea: ReadonlyMap<string, number>
): void {
	const insert = database.prepare(
		"INSERT OR REPLACE INTO soil_survey_area (areasymbol, areaname, saverest, saversion, survey_source_date, survey_source_title, source_scale, mapping_scale, area_acres, min_lat, min_lon, max_lat, max_lon, coverage_cells, coverage_resolution) " +
			"VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
	)

	database.exec("BEGIN")

	for (const area of options.areas) {
		const bounds = database
			.prepare(
				"SELECT min(min_lat) AS min_lat, min(min_lon) AS min_lon, max(max_lat) AS max_lat, max(max_lon) AS max_lon FROM soil_map_unit_area WHERE areasymbol = ?"
			)
			.get(area.attributes.areasymbol) as {
			min_lat: number | null
			min_lon: number | null
			max_lat: number | null
			max_lon: number | null
		}

		const row: SoilSurveyAreaTable = {
			areasymbol: area.attributes.areasymbol,
			areaname: area.attributes.areaname,
			saverest: area.attributes.saverest,
			saversion: area.attributes.saversion,
			survey_source_date: area.attributes.surveySourceDate,
			survey_source_title: area.attributes.surveySourceTitle,
			source_scale: area.attributes.sourceScale,
			mapping_scale: area.attributes.mappingScale,
			area_acres: area.attributes.areaAcres,
			min_lat: bounds.min_lat ?? 0,
			min_lon: bounds.min_lon ?? 0,
			max_lat: bounds.max_lat ?? 0,
			max_lon: bounds.max_lon ?? 0,
			coverage_cells: cellsByArea.get(area.attributes.areasymbol) ?? 0,
			coverage_resolution: options.coverageResolution,
		}

		insert.run(
			row.areasymbol,
			row.areaname,
			row.saverest,
			row.saversion,
			row.survey_source_date,
			row.survey_source_title,
			row.source_scale,
			row.mapping_scale,
			row.area_acres,
			row.min_lat,
			row.min_lon,
			row.max_lat,
			row.max_lon,
			row.coverage_cells,
			row.coverage_resolution
		)
	}

	database.exec("COMMIT")
}

/**
 * Inserts the authority's declared domains and the share weighting.
 *
 * Every cell row stores the weighting code.
 * The vocabulary row adds the description of that code.
 */
function writeVocabularyRows(database: DatabaseClient<SoilDatabase>, areas: ReadonlyArray<SurveyAreaInput>): void {
	const insert = database.prepare(
		"INSERT OR REPLACE INTO soil_vocabulary (domain, code, definition, sequence) VALUES (?, ?, ?, ?)"
	)

	database.exec("BEGIN")

	for (const area of areas) {
		for (const member of area.attributes.domains) {
			insert.run(member.domain, member.code, member.definition, member.sequence)
		}
	}

	insert.run("share_weighting", SOIL_SHARE_WEIGHTING, SOIL_SHARE_WEIGHTING_DESCRIPTION, WEIGHT_LATTICE_DEPTH)

	database.exec("COMMIT")
}
