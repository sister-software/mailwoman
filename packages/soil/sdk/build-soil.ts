/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build `soil.db` — the sealed polygon layer, from the survey areas NRCS publishes.
 *
 *   THE ACCUMULATION IS IN SQL, NOT IN A MAP. Classification is per delineation and shared with the
 *   resolution measurement, but where the touches GO differs on purpose: the measuring instrument holds
 *   them in memory because it is comparing candidate resolutions in one pass, and the builder streams them
 *   into a temporary table because memory has to stay flat in row count. A polygon layer's touches
 *   outnumber its features, and Iowa is 99 survey areas.
 *
 *   ABSENCE IS NO ROW, IN EVERY TABLE. Land outside a published survey area gets no `layer_coverage` row and
 *   no summary row — never a zero, never an empty histogram. Inside a published area the coverage row says
 *   `designated` at completeness 1.0, because NRCS declares its own mapping complete for those areas at its
 *   own scale; a coverage cell reached ONLY by `NOTCOM` and access-denied polygons gets no row either,
 *   because the polygon exists and the soil mapping behind it does not.
 *
 *   A COVERAGE ROW LICENSES ONLY THAT THE AUTHORITY MAPPED HERE. The reading is the class distribution, and
 *   a cell that is 100% `unrated_share` is `designated`-complete and carries no capability reading
 *   whatsoever. That pairing is not a corner case: 17.1% of national components carry no capability rating,
 *   and for the irrigated rating the figure is 85.1%.
 *
 *   THE AREA CROSS-CHECK USES THE AUTHORITY'S OWN PUBLISHED FIGURE. `legend.areaacres` is what NRCS states
 *   the survey area covers — 378,800 acres for `IA153`, which is 1,532.9 km² against the 1,532.5 km² an
 *   independent projected measurement of the same shapefile reports. Comparing the spherical ring sum
 *   against it catches a hole read as an exterior ring, whose absence is silent: such a polygon is
 *   well-formed and simply answers "inside" for ground the authority did not map.
 */

import {
	CoverageBasis,
	createLayerCoverageTable,
	createLayerManifestTable,
	LayerFreshnessPolicy,
	LayerTier,
	writeLayerCoverage,
	writeLayerManifest,
	type CoverageCell,
} from "@mailwoman/core/layers"
import { runChunkProcess } from "@mailwoman/core/utils"
import { rmSync, statSync } from "@mailwoman/platform/fs"
import { DatabaseSync } from "@mailwoman/platform/sqlite"
import { fileURLToPath } from "@mailwoman/platform/url"
import {
	geometryContains,
	interiorCoverageCells,
	shortCellToInt,
	type GeojsonGeometry,
	type GeojsonMultiPolygon,
	type GeojsonPolygon,
	type GeojsonPosition,
} from "@mailwoman/spatial"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { sealDatabase, swapDatabaseIntoPlace } from "@mailwoman/sqlite/sealed-db"
import { cellToLatLng } from "h3-js"

import { createSoilTables, type SoilDatabase, type SoilSurveyAreaTable } from "../schema.ts"
import {
	SOIL_SHARE_WEIGHTING,
	SOIL_SHARE_WEIGHTING_DESCRIPTION,
	soilLayerName,
	SSURGO_ATTRIBUTION,
	SSURGO_LICENSE,
	SSURGO_SOURCE,
} from "../vocabulary.ts"
import { reduceCells, resolveCells } from "./cell-tiers.ts"
import type { SoilChunkResult } from "./ingest-chunk.ts"
import { ingestSoilChunk } from "./ingest-chunk.ts"
import type { SoilFeatureSource } from "./ingest.ts"
import { WEIGHT_LATTICE_DEPTH } from "./reduce.ts"
import type { SurveyAreaAttributes } from "./survey-area.ts"

/**
 * Schema version of the domain tables. Bumped when a column changes meaning, never for an added column a reader can
 * ignore.
 */
export const SOIL_SCHEMA_VERSION = 1

/**
 * Delineation ids per chunk process.
 *
 * Sized against the ceiling the flood layer measured rather than guessed: single-process runs over that product died
 * after roughly 510,000 and 798,000 features as h3's WASM heap fragmented. 100,000 leaves five times that margin, and
 * the cost of a smaller number is one interpreter start per chunk. Iowa's largest survey area holds well under it, so
 * on this build the bound costs one process per area — which is what makes an area's failure nameable.
 */
export const DEFAULT_CHUNK_SIZE = 100_000

/**
 * Square metres in a square kilometre.
 */
const M2_PER_KM2 = 1_000_000

/**
 * Square metres in an acre — the unit `legend.areaacres` publishes in.
 */
const M2_PER_ACRE = 4046.8564224

/**
 * The relative gap between the ring-area total and the authority's own published acreage that fails the build.
 *
 * Two percent. The comparison is a spherical ring area against a figure NRCS itself warns "may differ from that
 * measured using GIS software due to different measuring techniques and rounding practices, or due to the fact that the
 * value has been adjusted so that the sum total of all map units in the legend equals that listed for soil survey area"
 * — so an exact test would be brittle. Two percent sits far above the 0.03% `IA153` measures and far below the error a
 * hole-blind read produces, which the zoning survey measured at 4.1% over a whole national layer.
 */
const AREA_TOLERANCE = 0.02

/**
 * One survey area, ready to build: where its geometry is, and what its tabular export said.
 */
export interface SurveyAreaInput {
	attributes: SurveyAreaAttributes
	/**
	 * The map-unit polygon shapefile.
	 */
	shapefilePath?: string
	/**
	 * The survey area's own outline, already read.
	 */
	outline: GeojsonGeometry
	/**
	 * An in-process feature source. Correct for a fixture and for anything small; the batched path builds one of these
	 * per chunk, so the two share one implementation.
	 */
	source?: SoilFeatureSource
	/**
	 * The delineation count the shapefile declares, when the caller has already read it.
	 */
	declaredFeatureCount?: number
}

export interface BuildSoilOptions {
	/**
	 * The survey areas to build, in the order they should be ingested.
	 */
	areas: ReadonlyArray<SurveyAreaInput>
	/**
	 * The region the layer name carries — the pilot's is `ia`.
	 */
	region: string
	/**
	 * Where the sealed artifact lands. The build writes beside it and swaps.
	 */
	out: string
	/**
	 * The refresh the build ingested — `layer_manifest.version` and `source_vintage`.
	 */
	sourceVintage: string
	buildCmd: string
	buildSHA: string
	/**
	 * ISO-8601, supplied by the caller. Never generated here: the contract says so, and a library-generated timestamp
	 * makes two builds of the same inputs differ.
	 */
	createdAt: string
	/**
	 * The resolution the cell index and the reduction are built at — chosen from the measurement.
	 */
	indexResolution: number
	/**
	 * The resolution `layer_coverage` rows are keyed at. Must be coarser than the index resolution.
	 */
	coverageResolution: number
	/**
	 * Delineation ids per chunk process. See {@link DEFAULT_CHUNK_SIZE}.
	 */
	chunkSize?: number
	/**
	 * Run the ingest IN THIS PROCESS rather than spawning chunk children. Only for fixtures, which carry no shapefile for
	 * a child to open.
	 */
	inProcess?: boolean
	onProgress?: (message: string) => void
}

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
	 * `partialCellRows / (wholeCellRows + partialCellRows)` over the STORED index rows. The whole side is compacted, so
	 * this is not the same number the resolution was chosen on and is reported separately.
	 */
	storedPartialShare: number
	capabilityCells: number
	/**
	 * Cells the lattice was used for, rather than the whole-cell fast path.
	 */
	sampledCells: number
	/**
	 * Cells whose top class covers less than half the cell — the §4.7 number, taken off the shipping artifact rather than
	 * out of a separate harness.
	 */
	topClassUnderHalfCells: number
	topClassUnderHalfShare: number
	/**
	 * Cells with NO class at all: the survey mapped them and rated nothing there.
	 */
	classlessCells: number
	/**
	 * Cells the index touched that no lattice point landed inside. Dropped rather than stored as an all-zero
	 * distribution, and counted because a large number would mean the lattice is too coarse for this geometry.
	 */
	unsampledCells: number
	meanDelineationsPerCell: number
	coarsenedFeatures: number
	storedResolutions: number[]
	coverageCells: number
	/**
	 * Coverage cells inside a survey-area outline that no delineation with soil mapping reached. Reported rather than
	 * smoothed over: SSURGO is wall-to-wall inside a published area, so a large number means the outline and the
	 * delineations disagree.
	 */
	coverageCellsWithoutMapping: number
	/**
	 * The two area readings in square kilometres, and the authority's own published figure.
	 */
	area: { publishedKM2: number; nestedKM2: number; allExteriorKM2: number; relativeGap: number }
	sizeBytes: number
}

/**
 * Build the layer.
 *
 * @throws {Error} On a delineation the classifier refuses, a streamed count that disagrees with the shapefile's own
 *   declaration, an area total that disagrees with the authority's published acreage, or a set of outlines that yields
 *   no interior coverage cell at all.
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

	const tmpPath = `${options.out}.tmp-${process.pid}`

	let streamed: StreamResult

	// THE INGEST AND THE RESOLVE PHASES USE SEPARATE HANDLES, ALWAYS — including the in-process path, which does not need
	// them separated. The batched path DOES: its children open the same file, so the parent's handle has to be closed
	// across them, and a single shared handle silently becomes a closed one by the time the cell tiers are resolved.
	{
		const kdb = new DatabaseClient<SoilDatabase>(tmpPath)

		try {
			kdb.exec("PRAGMA journal_mode = OFF")
			kdb.exec("PRAGMA synchronous = OFF")

			await createSoilTables(kdb)
			await createLayerManifestTable(kdb)
			await createLayerCoverageTable(kdb)

			// The touch table exists only for this build and is dropped before the artifact is sealed. No primary key while
			// loading: the resolution queries below read it through indexes created once the load is done, and a clustered
			// key would sort every insert against an ingest order nothing controls.
			kdb.exec(
				"CREATE TABLE build_cell_touch (h3_cell INTEGER NOT NULL, resolution INTEGER NOT NULL, area_id TEXT NOT NULL, is_full INTEGER NOT NULL)"
			)

			writeAttributes(kdb, options.areas)

			if (options.inProcess) {
				streamed = aggregateChunks(await ingestInProcess(kdb, options))
			}
		} catch (error) {
			await kdb.destroy().catch(() => undefined)
			rmSync(tmpPath, { force: true })

			throw error
		}

		await kdb.destroy()
	}

	if (!options.inProcess) {
		try {
			streamed = aggregateChunks(await runBatchedIngest(tmpPath, options))
		} catch (error) {
			rmSync(tmpPath, { force: true })

			throw error
		}
	}

	const kdb = new DatabaseClient<SoilDatabase>(tmpPath)

	try {
		kdb.exec("PRAGMA journal_mode = OFF")
		kdb.exec("PRAGMA synchronous = OFF")

		const ingested = streamed!

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

		await writeLayerManifest(kdb, {
			name: soilLayerName(options.region),
			version: options.sourceVintage,
			schemaVersion: SOIL_SCHEMA_VERSION,
			tier: LayerTier.Shipped,
			license: SSURGO_LICENSE,
			attribution: SSURGO_ATTRIBUTION,
			source: SSURGO_SOURCE,
			sourceVintage: options.sourceVintage,
			buildCmd: options.buildCmd,
			buildSHA: options.buildSHA,
			freshnessPolicy: LayerFreshnessPolicy.VersionedRefresh,
			// THE SPINE KEY NAMES THE TABLE A CONSUMER JOINS ON, table-qualified, per the layer contract. For this layer
			// that is the REDUCTION rather than the containment index: `soil_capability_cell` holds one row per cell at one
			// resolution, which `soil_map_unit_cell` does not — it is keyed `(cell, delineation)` and is mixed-resolution by
			// construction, so it is a tier the reader walks rather than a key a consumer joins.
			spineKeys: {
				h3: { column: "soil_capability_cell.h3_cell", resolution: options.indexResolution },
			},
			createdAt: options.createdAt,
		})

		kdb.exec("DROP TABLE build_cell_touch")
		kdb.exec("VACUUM")

		await kdb.destroy()

		sealDatabase(tmpPath)
		swapDatabaseIntoPlace(tmpPath, options.out)

		const totalCellRows = cells.wholeRows + cells.partialRows

		return {
			out: options.out,
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
			sizeBytes: sizeOf(options.out),
		}
	} catch (error) {
		await kdb.destroy().catch(() => undefined)

		// A failed build leaves a partial file whose name carries this process's pid, so nothing will ever pick it up
		// again. Removing it is the difference between a retry loop that fails and one that fills a disk.
		rmSync(tmpPath, { force: true })

		throw error
	}
}

/**
 * What the whole ingest produced, however many processes it took.
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
 * Add up what the chunks reported.
 *
 * Exported for its own test: the coverage-cell arithmetic is the one part of the batched path a fixture build cannot
 * reach, and getting it wrong produces a well-formed artifact that under-reports how many delineations a cell holds.
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

		// A coverage cell straddles chunk boundaries — a range of feature ids is not a region, and a coverage cell can
		// straddle two survey areas — so the counts ADD rather than replace.
		for (const [cell, count] of chunk.observedByCoverageCell) {
			observedByCoverageCell.set(cell, (observedByCoverageCell.get(cell) ?? 0) + count)
		}

		for (const [cell, count] of chunk.mappedByCoverageCell) {
			mappedByCoverageCell.set(cell, (mappedByCoverageCell.get(cell) ?? 0) + count)
		}
	}

	return { delineations, coarsened, byArea, observedByCoverageCell, mappedByCoverageCell, nestedM2, allExteriorM2 }
}

/**
 * Refuse a build that streamed fewer delineations than a survey area declares.
 *
 * A short read builds a smaller county and reports success, which is the partial result that must throw.
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
 * Refuse an artifact whose rings do not add up to the acreage the authority publishes.
 *
 * The message carries the hole-blind total beside the nested one, because the gap between them is the diagnosis: a hole
 * read as an exterior ring answers "inside" for every point in it.
 */
function assertAreaAgreement(areas: ReadonlyArray<SurveyAreaInput>, streamed: StreamResult): BuildSoilResult["area"] {
	let publishedAcres = 0
	let known = 0

	for (const input of areas) {
		if (input.attributes.areaAcres !== null) {
			publishedAcres += input.attributes.areaAcres

			known++
		}
	}

	const publishedKM2 = (publishedAcres * M2_PER_ACRE) / M2_PER_KM2
	const nestedKM2 = streamed.nestedM2 / M2_PER_KM2
	const allExteriorKM2 = streamed.allExteriorM2 / M2_PER_KM2

	// A build over survey areas that publish no acreage has no witness. That is a real absence — reported as a zero gap
	// rather than as agreement, and the `known` count above is what tells the two apart on a receipt.
	const relativeGap = publishedKM2 > 0 ? Math.abs(nestedKM2 - publishedKM2) / publishedKM2 : 0

	if (known && relativeGap > AREA_TOLERANCE) {
		throw new Error(
			`soil build: the encoded rings total ${nestedKM2.toFixed(1)} km² against the ${publishedKM2.toFixed(1)} km² the authority publishes for these ${known} survey areas ` +
				`(${(relativeGap * 100).toFixed(2)}% apart, tolerance ${(AREA_TOLERANCE * 100).toFixed(0)}%). Read without their holes the same rings total ` +
				`${allExteriorKM2.toFixed(1)} km², so compare the two: a hole-blind read answers "inside" for every point in a hole`
		)
	}

	return { publishedKM2, nestedKM2, allExteriorKM2, relativeGap }
}

/**
 * Write every survey area's map units, components and vocabulary before any geometry is streamed.
 *
 * Attributes FIRST because the ingest needs one thing out of them — which map units have no soil mapping behind them —
 * and because a delineation whose map unit is missing must fail while the artifact is still empty rather than after
 * millions of geometry rows are written.
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
 * The map units with no soil mapping behind them, from what was just written.
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
 * The in-process ingest — one chunk per survey area, all in this interpreter. Fixtures only.
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
 * Run the ingest as a sequence of bounded child processes, one per range of one survey area's FIDs.
 *
 * THE PARENT HOLDS NO HANDLE WHILE THEY RUN — its caller closed one before this and opens another after. Each child
 * opens the same file and appends; chunks run one at a time, so there is exactly one writer at every instant and no
 * locking to reason about.
 *
 * @throws {Error} When a chunk exits non-zero, or prints no result line — a chunk that died mid-range has written a
 *   partial set of rows, and continuing would seal an artifact missing delineations nobody could name.
 */
async function runBatchedIngest(tmpPath: string, options: BuildSoilOptions): Promise<SoilChunkResult[]> {
	const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE
	const script = fileURLToPath(import.meta.resolve("@mailwoman/soil/scripts/ingest-chunk"))
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
					args: [
						"--database",
						tmpPath,
						"--shapefile",
						area.shapefilePath,
						"--area-symbol",
						area.attributes.areasymbol,
						"--fid-from",
						String(from),
						"--fid-to",
						String(to),
						"--index-resolution",
						String(options.indexResolution),
						"--coverage-resolution",
						String(options.coverageResolution),
						"--no-mapping-mukeys",
						noMapping.join(","),
					],
				})
			)
		}
	}

	return chunks
}

/**
 * The coverage rows: one per interior cell of the built footprint that soil mapping actually reaches, and none outside.
 *
 * THE INTERIOR TEST RUNS ONCE OVER THE UNION OF EVERY OUTLINE BUILT, NOT PER SURVEY AREA, and the difference is most of
 * a state. The test is conservative — it keeps only cells lying WHOLLY inside — so applied per area it drops every cell
 * a county border crosses. Measured on Polk County alone at resolution 6: 20 interior cells against the roughly 42 the
 * county spans by area, so more than half of it would read `unknown` while sitting inside a survey the build had
 * ingested. Run over the union, only the OUTER border of the built set is dropped, which is the honest edge: beyond it
 * lies ground this artifact does not hold.
 *
 * The conservatism itself stays. A cell wrongly called interior would state that an authority determined a location it
 * never looked at, and a point in the dropped strip reading `unknown` is the truthful answer for ground the built set
 * may or may not reach.
 *
 * `observed_rows` counts the delineations reaching the cell, which is what the contract's column means. A cell reached
 * only by `NOTCOM` and access-denied polygons gets NO ROW — the polygon exists, the soil mapping behind it does not,
 * and the survey's §3.2 puts that case with the absences rather than with the coverage.
 */
function buildCoverageCells(
	options: BuildSoilOptions,
	streamed: StreamResult
): { cells: CoverageCell[]; cellsByArea: Map<string, number>; withoutMapping: number } {
	const footprint: GeojsonGeometry = {
		type: "MultiPolygon",
		coordinates: options.areas.flatMap((input) => outlinePolygons(input.outline)),
	}

	const interior = interiorCoverageCells(footprint, options.coverageResolution)

	if (!interior.length) {
		throw new Error(
			`soil build: the ${options.areas.length} built outline(s) yield no interior cell at resolution ${options.coverageResolution} — the artifact would carry no coverage rows and answer "unknown" everywhere while reporting success`
		)
	}

	const cells: CoverageCell[] = []
	const cellsByArea = new Map<string, number>()

	let withoutMapping = 0

	for (const cell of interior) {
		const h3Cell = shortCellToInt(cell)
		const mapped = streamed.mappedByCoverageCell.get(h3Cell) ?? 0

		if (!mapped) {
			withoutMapping++

			continue
		}

		cells.push({
			h3Cell,
			completeness: 1,
			basis: CoverageBasis.Designated,
			observedRows: streamed.observedByCoverageCell.get(h3Cell) ?? 0,
		})

		// Attributed by the cell's CENTRE, so each row is counted for exactly one survey area even where the cell straddles
		// two. The count is a per-area receipt, not part of the coverage claim — the claim is the row set itself.
		const [latitude, longitude] = cellToLatLng(cell)
		const owner = options.areas.find((input) => geometryContains(input.outline, longitude, latitude))

		if (owner) {
			const symbol = owner.attributes.areasymbol

			cellsByArea.set(symbol, (cellsByArea.get(symbol) ?? 0) + 1)
		}
	}

	return { cells: cells.toSorted((left, right) => left.h3Cell - right.h3Cell), cellsByArea, withoutMapping }
}

/**
 * One outline's polygons, in the `MultiPolygon` coordinate shape, whichever areal type it arrived as.
 *
 * @throws {TypeError} When the outline is not areal. A survey area whose footprint cannot be read would silently
 *   contribute nothing to the union, and the coverage over it would simply be absent.
 */
function outlinePolygons(outline: GeojsonGeometry): GeojsonPosition[][][] {
	if (outline.type === "MultiPolygon") return (outline as GeojsonMultiPolygon).coordinates

	if (outline.type === "Polygon") return [(outline as GeojsonPolygon).coordinates]

	throw new TypeError(
		`soil build: a survey-area outline is a ${outline.type}, which bounds no area — its coverage would be silently absent rather than refused`
	)
}

/**
 * Insert one row per survey area.
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
 * Insert the authority's declared domains, plus the weighting the shares were produced under.
 *
 * The weighting rides in the vocabulary table as well as on every row: the row-level copy is what a consumer reads, and
 * this one carries the sentence that says what it MEANS, which no column can.
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

/**
 * The artifact's size on disk, read once for the receipt.
 */
function sizeOf(path: string): number {
	return statSync(path).size
}
