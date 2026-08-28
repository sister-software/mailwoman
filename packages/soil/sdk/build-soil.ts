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

import { spawn } from "node:child_process"
import { rmSync, statSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"

import { DatabaseClient } from "@mailwoman/core/kysley/client"
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
import { parseJSONStrict } from "@mailwoman/core/objects"
import { sealDatabase, swapDatabaseIntoPlace } from "@mailwoman/core/utils"
import {
	expandH3Cell,
	interiorCoverageCellSet,
	shortCellToInt,
	type GeojsonGeometry,
	type H3Cell,
	type H3CellShort,
} from "@mailwoman/spatial"
import { compactCells, getResolution } from "h3-js"
import { TextSpliterator } from "spliterator"

import {
	createSoilTables,
	SoilCellContainment,
	type SoilCapabilityCellTable,
	type SoilDatabase,
	type SoilSurveyAreaTable,
} from "../schema.ts"
import {
	SOIL_SHARE_WEIGHTING,
	SOIL_SHARE_WEIGHTING_DESCRIPTION,
	soilLayerName,
	SSURGO_ATTRIBUTION,
	SSURGO_LICENSE,
	SSURGO_SOURCE,
} from "../vocabulary.ts"
import type { SoilChunkResult } from "./ingest-chunk.ts"
import { ingestSoilChunk } from "./ingest-chunk.ts"
import type { SoilFeatureSource } from "./ingest.ts"
import { mapUnitProfile, reduceCell, WEIGHT_LATTICE_DEPTH, type CellCandidate, type MapUnitProfile } from "./reduce.ts"
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
 *   declaration, an area total that disagrees with the authority's published acreage, or a survey area whose outline
 *   yields no interior coverage cell.
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
		const database = new DatabaseSync(tmpPath)
		const kdb = new DatabaseClient<SoilDatabase>({ database })

		try {
			database.exec("PRAGMA journal_mode = OFF")
			database.exec("PRAGMA synchronous = OFF")

			await createSoilTables(kdb)
			await createLayerManifestTable(kdb)
			await createLayerCoverageTable(kdb)

			// The touch table exists only for this build and is dropped before the artifact is sealed. No primary key while
			// loading: the resolution queries below read it through indexes created once the load is done, and a clustered
			// key would sort every insert against an ingest order nothing controls.
			database.exec(
				"CREATE TABLE build_cell_touch (h3_cell INTEGER NOT NULL, resolution INTEGER NOT NULL, area_id TEXT NOT NULL, is_full INTEGER NOT NULL)"
			)

			writeAttributes(database, options.areas)

			if (options.inProcess) {
				streamed = aggregateChunks(await ingestInProcess(database, options))
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

	const database = new DatabaseSync(tmpPath)
	const kdb = new DatabaseClient<SoilDatabase>({ database })

	try {
		database.exec("PRAGMA journal_mode = OFF")
		database.exec("PRAGMA synchronous = OFF")

		const ingested = streamed!

		assertDelineationCounts(options.areas, ingested)
		const area = assertAreaAgreement(options.areas, ingested)

		options.onProgress?.(`${ingested.delineations.toLocaleString()} delineations written · resolving cells`)

		const cells = resolveCells(database, options.indexResolution)

		options.onProgress?.(
			`${cells.wholeRows.toLocaleString()} whole (compacted) · ${cells.partialRows.toLocaleString()} partial · reducing`
		)

		const reduced = reduceCells(database, options.indexResolution, options.onProgress)

		const coverage = buildCoverageCells(options, ingested)

		await writeLayerCoverage(kdb, coverage.cells)

		writeSurveyAreaRows(database, options, coverage.cellsByArea)
		writeVocabularyRows(database, options.areas)

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

		database.exec("DROP TABLE build_cell_touch")
		database.exec("VACUUM")

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
function writeAttributes(database: DatabaseSync, areas: ReadonlyArray<SurveyAreaInput>): void {
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
async function ingestInProcess(database: DatabaseSync, options: BuildSoilOptions): Promise<SoilChunkResult[]> {
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

			const stdout = await runChunkProcess(script, [
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
			])

			const line = TextSpliterator.from(stdout.trim(), { delimiter: "\n" }).toArray().at(-1)

			if (!line) {
				throw new Error(
					`soil build: chunk ${area.attributes.areasymbol} FID ${from}–${to} printed no result — its rows are in the artifact unaccounted for`
				)
			}

			chunks.push(parseJSONStrict<SoilChunkResult>(line))
		}
	}

	return chunks
}

/**
 * Run one chunk process, returning its stdout.
 *
 * Progress is INHERITED rather than captured, so a long chunk reports as it goes and only the result line has to be
 * parsed. A non-zero exit throws: a chunk that died mid-range has already written part of its rows, and continuing
 * would seal an artifact missing delineations nobody could name.
 */
async function runChunkProcess(script: string, args: readonly string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [script, ...args], { stdio: ["ignore", "pipe", "inherit"] })
		const stdout: string[] = []

		child.stdout.setEncoding("utf8")

		child.stdout.on("data", (chunk: string) => {
			stdout.push(chunk)
		})

		child.on("error", reject)

		child.on("close", (code) => {
			if (code === 0) {
				resolve(stdout.join(""))

				return
			}

			reject(new Error(`soil build: chunk process exited ${code}`))
		})
	})
}

/**
 * Resolve the touch table into the stored containment index.
 *
 * Compaction happens HERE and only on the whole side. It is expected to yield close to nothing on this layer, which is
 * the inversion the survey predicts: compaction needs a uniform interior, and 85.4% of `IA153`'s delineations are
 * smaller than one resolution-9 cell.
 */
function resolveCells(
	database: DatabaseSync,
	indexResolution: number
): { wholeRows: number; partialRows: number; resolutions: number[] } {
	database.exec("CREATE INDEX build_cell_touch_area_cell ON build_cell_touch (area_id, resolution, is_full, h3_cell)")

	const groups = database
		.prepare("SELECT DISTINCT area_id, resolution FROM build_cell_touch WHERE is_full = 1")
		.all() as Array<{ area_id: string; resolution: number }>

	const insertCell = database.prepare(
		"INSERT OR REPLACE INTO soil_map_unit_cell (h3_cell, resolution, area_id, containment) VALUES (?, ?, ?, ?)"
	)

	const resolutions = new Set<number>()

	let wholeRows = 0

	// One group per (delineation, resolution): `compactCells` takes a single resolution, and an adaptively-indexed layer
	// has several. Pooling them throws; compacting only the target-resolution group would silently drop every coarsened
	// delineation's interior.
	database.exec("BEGIN")

	for (const { area_id: areaID, resolution } of groups) {
		const whole = database
			.prepare("SELECT DISTINCT h3_cell FROM build_cell_touch WHERE area_id = ? AND resolution = ? AND is_full = 1")
			.all(areaID, resolution) as Array<{ h3_cell: number }>

		for (const cell of compactCells(whole.map((row) => shortCellToLong(row.h3_cell, resolution)))) {
			const cellResolution = getResolution(cell)

			resolutions.add(cellResolution)
			insertCell.run(shortCellToInt(cell as H3Cell), cellResolution, areaID, SoilCellContainment.Whole)

			wholeRows++
		}
	}

	database.exec("COMMIT")

	// The partial rows are every touch that is not whole for its own delineation. `INSERT OR REPLACE` above already put
	// the whole rows in, and the primary key is `(h3_cell, area_id)`, so this insert must skip them explicitly rather
	// than rely on the key: a partial row replacing a whole one would demote an answered cell to a ray cast.
	database.exec(
		"INSERT OR IGNORE INTO soil_map_unit_cell (h3_cell, resolution, area_id, containment) " +
			"SELECT DISTINCT t.h3_cell, t.resolution, t.area_id, 'partial' FROM build_cell_touch t WHERE t.is_full = 0"
	)

	const partialRows = (
		database.prepare("SELECT count(*) AS n FROM soil_map_unit_cell WHERE containment = 'partial'").get() as {
			n: number
		}
	).n

	for (const row of database.prepare("SELECT DISTINCT resolution FROM soil_map_unit_cell").all() as Array<{
		resolution: number
	}>) {
		resolutions.add(row.resolution)
	}

	resolutions.add(indexResolution)

	return { wholeRows, partialRows, resolutions: [...resolutions].toSorted((left, right) => left - right) }
}

/**
 * Cells reduced per progress report. The reduction is the slow phase — a lattice of 49 point tests per sampled cell —
 * so it reports often enough that a long run is visibly alive.
 */
const REDUCE_PROGRESS_STRIDE = 50_000

/**
 * One delineation's geometry, as the reduction reads it.
 */
interface StoredDelineation {
	mukey: string
	min_lat: number
	min_lon: number
	max_lat: number
	max_lon: number
	rings: Uint8Array
}

/**
 * How many delineations the reduction keeps in memory at once.
 *
 * Sized to bound the phase rather than to hold everything: the pilot region's median delineation encodes to roughly 1.4
 * kB, so 200,000 of them is a few hundred megabytes — comfortable, and far below the 2.5 million a whole state holds.
 * Memory stays flat in row count, which is the property the poi build lost when a reader materialized instead of
 * streaming.
 */
const GEOMETRY_CACHE_ENTRIES = 200_000

/**
 * Reduce the touch table into `soil_capability_cell`.
 *
 * Reads the touch table rather than `soil_map_unit_cell` on purpose: the stored index is compacted on the whole side,
 * so a compacted parent no longer names the cells the reduction has to answer. The touch table is the uncompacted truth
 * about which delineation reaches which cell.
 */
function reduceCells(
	database: DatabaseSync,
	indexResolution: number,
	onProgress?: (message: string) => void
): {
	cells: number
	sampled: number
	topClassUnderHalf: number
	classless: number
	unsampled: number
	candidatePairs: number
} {
	const profiles = readMapUnitProfiles(database)

	const insert = database.prepare(
		"INSERT OR REPLACE INTO soil_capability_cell (h3_cell, class_shares, unrated_share, notrateable_share, nodata_share, other_share, mapped_share, top_class, top_class_share, weighting, delineations) " +
			"VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
	)

	const selectArea = database.prepare(
		"SELECT mukey, min_lat, min_lon, max_lat, max_lon, rings FROM soil_map_unit_area WHERE area_id = ?"
	)

	const rows = database
		.prepare("SELECT h3_cell, resolution, area_id, is_full FROM build_cell_touch ORDER BY resolution, h3_cell, area_id")
		.iterate() as Iterable<{ h3_cell: number; resolution: number; area_id: string; is_full: number }>

	let cells = 0
	let sampled = 0
	let topClassUnderHalf = 0
	let classless = 0
	let unsampled = 0
	let candidatePairs = 0

	let currentCell: number | undefined
	let currentResolution = indexResolution
	let candidates: CellCandidate[] = []

	// A delineation is named by every cell it reaches — 5.35 of them per cell at resolution 9 on the pilot region — so a
	// naive read fetches each ring blob once per touch. At Iowa's scale that is millions of blob reads of ground already
	// in memory. The cache is bounded and CLEARED WHOLE when it fills rather than evicted one at a time: h3 cell integers
	// carry their ancestry in their high bits, so a scan in `h3_cell` order visits neighbours together and a cleared cache
	// refills with the delineations the next run of cells actually names.
	const geometry = new Map<string, StoredDelineation>()

	database.exec("BEGIN")

	const flush = (): void => {
		if (currentCell === undefined || !candidates.length) return

		const cell = expandH3Cell(
			currentCell.toString(16).padStart(SHORT_CELL_HEX_LENGTH, "0") as H3CellShort,
			currentResolution
		) as H3Cell

		const reducedCell = reduceCell(cell, currentResolution, candidates, profiles, currentCell)

		candidatePairs += candidates.length

		if (reducedCell.row.mapped_share <= 0) {
			unsampled++

			return
		}

		cells++

		if (reducedCell.sampled) {
			sampled++
		}

		if (reducedCell.topClassUnderHalf) {
			topClassUnderHalf++
		}

		if (!reducedCell.row.top_class) {
			classless++
		}

		insertRow(insert, reducedCell.row)

		if (cells % REDUCE_PROGRESS_STRIDE === 0) {
			database.exec("COMMIT")
			database.exec("BEGIN")

			onProgress?.(`${cells.toLocaleString()} cells reduced`)
		}
	}

	for (const row of rows) {
		if (row.h3_cell !== currentCell || row.resolution !== currentResolution) {
			flush()

			currentCell = row.h3_cell
			currentResolution = row.resolution
			candidates = []
		}

		let area = geometry.get(row.area_id)

		if (!area) {
			area = selectArea.get(row.area_id) as StoredDelineation | undefined

			if (!area) {
				throw new Error(
					`soil build: the touch table names delineation ${row.area_id}, which soil_map_unit_area does not hold — the ingest and the reduction disagree about what was written`
				)
			}

			if (geometry.size >= GEOMETRY_CACHE_ENTRIES) {
				geometry.clear()
			}

			geometry.set(row.area_id, area)
		}

		candidates.push({
			areaID: row.area_id,
			mukey: area.mukey,
			containment: row.is_full ? SoilCellContainment.Whole : SoilCellContainment.Partial,
			minLat: area.min_lat,
			minLon: area.min_lon,
			maxLat: area.max_lat,
			maxLon: area.max_lon,
			rings: area.rings,
		})
	}

	flush()

	database.exec("COMMIT")

	return { cells, sampled, topClassUnderHalf, classless, unsampled, candidatePairs }
}

/**
 * Number of hex characters in a stored short cell — 52 bits.
 */
const SHORT_CELL_HEX_LENGTH = 13

function insertRow(statement: ReturnType<DatabaseSync["prepare"]>, row: SoilCapabilityCellTable): void {
	statement.run(
		row.h3_cell,
		row.class_shares,
		row.unrated_share,
		row.notrateable_share,
		row.nodata_share,
		row.other_share,
		row.mapped_share,
		row.top_class,
		row.top_class_share,
		row.weighting,
		row.delineations
	)
}

/**
 * Every map unit's per-unit-area profile, computed once and reused for every cell it reaches.
 */
function readMapUnitProfiles(database: DatabaseSync): Map<string, MapUnitProfile> {
	const componentsByMukey = new Map<
		string,
		Array<{ comppct_r: number; compkind: string | null; nirrcapcl: string | null }>
	>()

	for (const row of database
		.prepare("SELECT mukey, comppct_r, compkind, nirrcapcl FROM soil_component")
		.all() as Array<{ mukey: string; comppct_r: number; compkind: string | null; nirrcapcl: string | null }>) {
		const list = componentsByMukey.get(row.mukey)

		if (list) {
			list.push(row)
		} else {
			componentsByMukey.set(row.mukey, [row])
		}
	}

	const profiles = new Map<string, MapUnitProfile>()

	for (const row of database.prepare("SELECT mukey, no_mapping FROM soil_map_unit").all() as Array<{
		mukey: string
		no_mapping: number
	}>) {
		profiles.set(row.mukey, mapUnitProfile(row, componentsByMukey.get(row.mukey) ?? []))
	}

	return profiles
}

/**
 * The coverage rows: one per interior cell of a published survey area's outline that soil mapping actually reaches, and
 * none outside.
 *
 * `observed_rows` counts the delineations reaching the cell, which is what the contract's column means. A cell reached
 * only by `NOTCOM` and access-denied polygons gets NO ROW — the polygon exists, the soil mapping behind it does not,
 * and the survey's §3.2 puts that case with the absences rather than with the coverage.
 */
function buildCoverageCells(
	options: BuildSoilOptions,
	streamed: StreamResult
): { cells: CoverageCell[]; cellsByArea: Map<string, number>; withoutMapping: number } {
	const cells: CoverageCell[] = []
	const cellsByArea = new Map<string, number>()
	const seen = new Set<number>()

	let withoutMapping = 0

	for (const area of options.areas) {
		const interior = interiorCoverageCellSet(area.outline, options.coverageResolution)

		if (!interior.size) {
			throw new Error(
				`soil build: ${area.attributes.areasymbol}'s outline yields no interior cell at resolution ${options.coverageResolution} — the artifact would carry no coverage rows for it and answer "unknown" over a survey area it did build`
			)
		}

		let written = 0

		for (const h3Cell of interior) {
			if (seen.has(h3Cell)) continue

			const mapped = streamed.mappedByCoverageCell.get(h3Cell) ?? 0

			if (!mapped) {
				withoutMapping++

				continue
			}

			seen.add(h3Cell)

			written++

			cells.push({
				h3Cell,
				completeness: 1,
				basis: CoverageBasis.Designated,
				observedRows: streamed.observedByCoverageCell.get(h3Cell) ?? 0,
			})
		}

		cellsByArea.set(area.attributes.areasymbol, written)
	}

	return { cells: cells.toSorted((left, right) => left.h3Cell - right.h3Cell), cellsByArea, withoutMapping }
}

/**
 * Insert one row per survey area.
 */
function writeSurveyAreaRows(
	database: DatabaseSync,
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
function writeVocabularyRows(database: DatabaseSync, areas: ReadonlyArray<SurveyAreaInput>): void {
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
 * The full H3 index for a short cell stored at `resolution`.
 *
 * Through `expandH3Cell` rather than a string concatenation, because it VALIDATES: a short cell that does not name a
 * valid cell at the stated resolution throws here instead of reaching `compactCells` as a plausible-looking index.
 */
function shortCellToLong(shortCell: number, resolution: number): string {
	return expandH3Cell(shortCell.toString(16).padStart(SHORT_CELL_HEX_LENGTH, "0") as H3CellShort, resolution)
}

/**
 * The artifact's size on disk, read once for the receipt.
 */
function sizeOf(path: string): number {
	return statSync(path).size
}
