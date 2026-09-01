/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build `flood.db` — the sealed two-tier polygon layer, from the authority's published geodatabase.
 *
 *   THE ACCUMULATION IS IN SQL, NOT IN A MAP. Classification is per feature and shared with the resolution
 *   measurement (`classifyFeatureCells`), but where the touches GO differs on purpose: the measuring
 *   instrument holds them in memory because it is comparing candidate resolutions in one pass, and the
 *   builder streams them into a temporary table because memory has to stay flat in row count. The poi
 *   build ran out of heap at 13.68M rows for exactly the shape this avoids, and a polygon layer's touches
 *   outnumber its features.
 *
 *   ZONE 1 IS WRITTEN AS COVERAGE, NOT AS ROWS. Inside England a location with no polygon is not
 *   unsurveyed — the Planning Practice Guidance defines Zone 1 as the land outside Zones 2 and 3 — so the
 *   designated absence is carried by a `layer_coverage` row at `basis = designated`, `completeness = 1.0`.
 *   Outside England there is NO ROW, because the EA's statement says nothing about Wales, Scotland or
 *   Northern Ireland, each of which has a different authority and a different zone scheme. Those two
 *   readings must never collapse into one another, and the negative half of the verification exists to
 *   prove they do not.
 *
 *   A COVERAGE ROW LICENSES ONLY THAT THE AUTHORITY DETERMINED HERE. The hazard reading is the zone value.
 *   A `designated`-complete cell holding no polygon says the EA's map assigns Zone 1 there; it does not
 *   say the location will not flood, and the authority itself declines that second statement.
 *
 *   THE COVERAGE CELL OF A ROW IS `cellToParent` OF ITS FINER CELL, never a fresh `latLngToCell` at the
 *   coarse resolution — that is what every existing reader in this repo does, and the two agree for a
 *   point but not for a cell.
 *
 *   THE AREA CROSS-CHECK IS BELT AND BRACES AND IT STAYS. The EA's rings nest their holes properly, so the
 *   orientation-encoded hole trap the zoning survey measured does not fire here. The check costs one
 *   subtraction per feature and its absence is silent: a hole read as an exterior ring produces a
 *   well-formed polygon that simply covers ground the authority did not map, and answers "inside" for
 *   every point in it.
 */

import { readFileSize } from "@mailwoman/core/fs/readers"
import {
	assertAreaAgreement,
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
import { expandShortCellInt, shortCellToInt, type H3Cell } from "@mailwoman/spatial"
import type { DatabaseClient } from "@mailwoman/sqlite/client"
import { buildSealedArtifact } from "@mailwoman/sqlite/sealed-build"
import { compactCells, getResolution } from "h3-js"

import { createFloodTables, FloodCellContainment, type FloodDatabase } from "#schema"
import type { FloodMapExtent } from "#sdk/extent"
import type { FloodFeatureSource } from "#sdk/ingest"
import { ingestFloodChunk, type FloodChunkResult } from "#sdk/ingest-chunk"
import {
	EA_FLOOD_ATTRIBUTION,
	EA_FLOOD_DATASET_ID,
	EA_FLOOD_LAYER_NAME,
	EA_FLOOD_LICENSE,
	EA_FLOOD_ZONE_DEFINITIONS,
} from "#vocabulary"

/**
 * Schema version of the domain tables. Bumped when a column changes meaning, never for an added column a reader can
 * ignore.
 */
export const FLOOD_SCHEMA_VERSION = 1

/**
 * Where a build gets its features, and — for a real one — how it bounds each process's share of them.
 */
export type BuildFloodInput =
	| {
			/**
			 * A feature source consumed IN THIS PROCESS. Correct for a fixture and for anything small; it is what the batched
			 * form falls back to per chunk, so the two share one implementation.
			 */
			source: FloodFeatureSource
	  }
	| {
			/**
			 * The published geodatabase, ingested in bounded chunks — one child process per range of the authority's own
			 * feature ids.
			 *
			 * This is the shape a national build takes, and the reason is reproducibility rather than speed: h3's WASM heap
			 * cannot be reset from JavaScript and does not survive an unbounded number of polyfill calls, so a single-process
			 * build over 813,627 polygons succeeds or fails on how the allocator happens to fragment. See `ingest-chunk.ts`.
			 */
			batched: {
				geodatabasePath: string
				layer?: string
				/**
				 * Inclusive bounds of the authority's own `OBJECTID` values, and the feature count they should yield.
				 */
				objectIDFrom: number
				objectIDTo: number
				declaredFeatureCount: number
				/**
				 * Feature ids per chunk. See {@link DEFAULT_CHUNK_SIZE}.
				 */
				chunkSize?: number
			}
	  }

export type BuildFloodOptions = BuildFloodInput & {
	/**
	 * Where the sealed artifact lands. The build writes beside it and swaps.
	 */
	out: string
	/**
	 * The product's ISO revision date — `layer_manifest.version` and `source_vintage`.
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
	 * The resolution the cell index is built at — chosen from the `partial`-share measurement.
	 */
	indexResolution: number
	/**
	 * The resolution `layer_coverage` rows are keyed at. Must be coarser than the index resolution.
	 */
	coverageResolution: number
	/**
	 * The authority's footprint, already realized against a boundary artifact.
	 */
	extent: FloodMapExtent
	/**
	 * The feature count a SECOND distribution channel reports — the live WFS. Supplied, it is asserted against the
	 * geodatabase's own count, which is the cheapest two-path check available and catches a stale or truncated archive
	 * before anything is written.
	 */
	expectedFeatureCount?: number
	onProgress?: (message: string) => void
}

export interface BuildFloodResult {
	out: string
	features: number
	zoneCounts: Record<string, number>
	indexResolution: number
	coverageResolution: number
	wholeCellRows: number
	partialCellRows: number
	candidateRows: number
	/**
	 * `partialCellRows / (wholeCellRows + partialCellRows)` at the built resolution, over the STORED rows — the whole
	 * side is compacted, so this is not the same number the resolution was chosen on and is reported separately.
	 */
	storedPartialShare: number
	/**
	 * Features whose bounding box forced a resolution coarser than `indexResolution`, and the resolutions the stored cell
	 * rows are actually at. Both are reported rather than smoothed over: a reader that assumed one resolution would probe
	 * at the wrong one and read every coarsened feature as an absence.
	 */
	coarsenedFeatures: number
	storedResolutions: number[]
	coverageCells: number
	coverageCellsWithRows: number
	/**
	 * The area totals in square kilometres — what the source says, what the encoded rings say read with their holes, and
	 * what they would say read without — with the witness stated.
	 */
	area: AreaAgreementReading
	sizeBytes: number
}

/**
 * Build the layer.
 *
 * @throws {Error} On an unknown zone code, a feature that reaches no cell, a feature count that disagrees with the
 *   source's own declaration, or an area total that disagrees with the source's.
 */
export async function buildFloodDatabase(options: BuildFloodOptions): Promise<BuildFloodResult> {
	if (options.coverageResolution >= options.indexResolution) {
		throw new Error(
			`flood build: the coverage resolution (${options.coverageResolution}) must be coarser than the index resolution (${options.indexResolution}) — a row's coverage cell is the PARENT of its index cell`
		)
	}

	const batched = "batched" in options ? options.batched : undefined
	const source = "batched" in options ? undefined : options.source
	const declaredFeatureCount = batched ? batched.declaredFeatureCount : source!.declaredFeatureCount

	options.onProgress?.(
		batched
			? `source: ${batched.geodatabasePath} · OBJECTID ${batched.objectIDFrom}–${batched.objectIDTo} · ${declaredFeatureCount.toLocaleString()} features`
			: `source: ${source!.layer} · EPSG:${source!.epsg} · ${declaredFeatureCount.toLocaleString()} features · ${source!.origin}`
	)

	if (options.expectedFeatureCount !== undefined && options.expectedFeatureCount !== declaredFeatureCount) {
		throw new Error(
			`flood build: the source declares ${declaredFeatureCount} features and the live service reports ${options.expectedFeatureCount} — the archive is a different vintage from the one the service is publishing`
		)
	}

	const built = await buildSealedArtifact<FloodDatabase, StreamResult, Omit<BuildFloodResult, "sizeBytes">>({
		out: options.out,
		createTables: async (kdb) => {
			await createFloodTables(kdb)
			await createLayerManifestTable(kdb)
			await createLayerCoverageTable(kdb)

			// The touch table exists only for this build and is dropped before the artifact is sealed. No primary key while
			// loading: the resolution queries below read it through indexes created once the load is done, and a clustered
			// key would sort every insert against an ingest order nothing controls.
			kdb.exec(
				"CREATE TABLE build_cell_touch (h3_cell INTEGER NOT NULL, resolution INTEGER NOT NULL, zone_code TEXT NOT NULL, area_id TEXT NOT NULL, is_full INTEGER NOT NULL)"
			)
		},
		ingest: async (kdb) => {
			if (!source) return undefined

			return aggregateChunks([
				await ingestFloodChunk(kdb, {
					source,
					indexResolution: options.indexResolution,
					coverageResolution: options.coverageResolution,
					...(options.onProgress ? { onProgress: options.onProgress } : {}),
				}),
			])
		},
		...(batched ? { batched: (tmpPath: string) => runBatchedIngest(tmpPath, options, batched) } : {}),
		finish: async (kdb, ingested) => {
			if (ingested.features !== declaredFeatureCount) {
				throw new Error(
					`flood build: streamed ${ingested.features} features, the source declares ${declaredFeatureCount} — a short read builds a smaller England and reports success`
				)
			}

			assertAreaAgreement("flood build", ingested.area, AREA_TOLERANCE)

			options.onProgress?.(`${ingested.features.toLocaleString()} features written · resolving cells`)

			const cells = resolveCells(kdb)

			options.onProgress?.(
				`${cells.wholeRows.toLocaleString()} whole (compacted) · ${cells.partialRows.toLocaleString()} partial · ${cells.candidateRows.toLocaleString()} candidate pairs`
			)

			const coverage = buildCoverageCells(options.extent, ingested.observedByCoverageCell)

			await writeLayerCoverage(kdb, coverage)

			writeExtentRow(kdb, options, coverage.length)
			writeVocabularyRows(kdb)

			await writeLayerManifest(
				kdb,
				polygonLayerManifest(options, {
					name: EA_FLOOD_LAYER_NAME,
					schemaVersion: FLOOD_SCHEMA_VERSION,
					license: EA_FLOOD_LICENSE,
					attribution: EA_FLOOD_ATTRIBUTION,
					source: `environment.data.gov.uk/dataset/${EA_FLOOD_DATASET_ID}`,
					cellColumn: "flood_zone_cell.h3_cell",
				})
			)

			kdb.exec("DROP TABLE build_cell_touch")

			const totalCellRows = cells.wholeRows + cells.partialRows

			return {
				out: options.out,
				features: ingested.features,
				zoneCounts: ingested.zoneCounts,
				indexResolution: options.indexResolution,
				coverageResolution: options.coverageResolution,
				wholeCellRows: cells.wholeRows,
				partialCellRows: cells.partialRows,
				candidateRows: cells.candidateRows,
				storedPartialShare: totalCellRows ? cells.partialRows / totalCellRows : 0,
				coarsenedFeatures: ingested.coarsened,
				storedResolutions: cells.resolutions,
				coverageCells: coverage.length,
				coverageCellsWithRows: coverage.filter((cell) => cell.observedRows > 0).length,
				area: ingested.area,
			}
		},
	})

	return { ...built, sizeBytes: await readFileSize(options.out) }
}

/**
 * What the whole ingest produced, however many processes it took.
 */
interface StreamResult {
	features: number
	coarsened: number
	zoneCounts: Record<string, number>
	observedByCoverageCell: Map<number, number>
	area: AreaAgreementReading
}

/**
 * The relative gap between the two area readings that fails the build.
 *
 * The comparison is a spherical ring area against GDAL's planar area in the source's own projection, so the two never
 * agree exactly: British National Grid's scale factor runs 0.9996 at its central meridian to about 1.0004 at the edges
 * of its usable zone, contributing roughly a tenth of a percent, and the spherical approximation contributes a similar
 * amount against the ellipsoid. One percent leaves both far inside the tolerance while sitting well below the error a
 * hole-blind read produces — the zoning survey measured that at 4.1% over a whole national layer, and this product's
 * own smoke rung at 17%.
 */
const AREA_TOLERANCE = 0.01

/**
 * Feature ids per chunk process.
 *
 * Sized against the measured ceiling rather than guessed: single-process runs over this product died after roughly
 * 510,000 and 798,000 features as h3's WASM heap fragmented. 100,000 leaves five times that margin, and the cost of a
 * smaller number is only one interpreter start per chunk.
 */
export const DEFAULT_CHUNK_SIZE = 100_000

/**
 * Add up what the chunks reported.
 *
 * Exported for its own test: the coverage-cell arithmetic is the one part of the batched path that a fixture build
 * cannot reach, and getting it wrong produces a well-formed artifact that under-reports how many polygons a cell
 * holds.
 */
export function aggregateChunks(chunks: ReadonlyArray<FloodChunkResult>): StreamResult {
	const zoneCounts: Record<string, number> = {}
	const observedByCoverageCell = new Map<number, number>()

	let features = 0
	let coarsened = 0
	let sourceArea = 0
	let nestedArea = 0
	let allExteriorArea = 0

	for (const chunk of chunks) {
		features += chunk.features
		coarsened += chunk.coarsened
		sourceArea += chunk.area.sourceM2
		nestedArea += chunk.area.nestedM2
		allExteriorArea += chunk.area.allExteriorM2

		for (const [zone, count] of Object.entries(chunk.zoneCounts)) {
			zoneCounts[zone] = (zoneCounts[zone] ?? 0) + count
		}

		// A coverage cell straddles chunk boundaries — a range of feature ids is not a region — so the counts ADD rather
		// than replace. Taking the last chunk's value would report a busy floodplain as holding only its final few
		// polygons.
		mergeCountsInto(observedByCoverageCell, chunk.observedByCoverageCell)
	}

	return {
		features,
		coarsened,
		zoneCounts,
		observedByCoverageCell,
		area: areaAgreementFrom({ nestedM2: nestedArea, allExteriorM2: allExteriorArea }, sourceArea),
	}
}

/**
 * Run the ingest as a sequence of bounded child processes, one per range of the authority's feature ids. The shared
 * chunk contract — the parent's no-handle rule, and the fail-loud handling of a chunk that dies or prints nothing —
 * lives with `ingestChunkArguments` and `runChunkProcess`.
 */
async function runBatchedIngest(
	tmpPath: string,
	options: BuildFloodOptions,
	batched: Extract<BuildFloodInput, { batched: unknown }>["batched"]
): Promise<StreamResult> {
	const chunkSize = batched.chunkSize ?? DEFAULT_CHUNK_SIZE
	const script = resolveModulePath("@mailwoman/flood/scripts/ingest-chunk")
	const chunks: FloodChunkResult[] = []

	for (let from = batched.objectIDFrom; from <= batched.objectIDTo; from += chunkSize) {
		const to = Math.min(from + chunkSize - 1, batched.objectIDTo)

		options.onProgress?.(`chunk OBJECTID ${from}–${to}`)

		chunks.push(
			await runChunkProcess<FloodChunkResult>({
				script,
				context: "flood build",
				subject: `chunk OBJECTID ${from}–${to}`,
				args: ingestChunkArguments({
					database: tmpPath,
					args: [
						"--gdb",
						batched.geodatabasePath,
						...(batched.layer ? ["--layer", batched.layer] : []),
						"--object-id-from",
						String(from),
						"--object-id-to",
						String(to),
						// A range's own count is not knowable up front — `ogrinfo` reports the layer's total and nothing narrower —
						// so the chunk asserts nothing about its size and the PARENT checks the sum against the whole file.
						"--declared-feature-count",
						String(0),
					],
					indexResolution: options.indexResolution,
					coverageResolution: options.coverageResolution,
				}),
			})
		)
	}

	return aggregateChunks(chunks)
}

/**
 * Resolve the touch table into the two stored cell tiers.
 *
 * Compaction happens HERE and only on the whole side. A zone's uniform interior collapses parent-ward into a handful of
 * coarse cells while the fringe stays fine — hierarchy-respecting run-length encoding. A partial cell's parent is not
 * partial in any useful sense, so compacting the fringe would claim it covers ground it does not.
 */
function resolveCells(database: DatabaseClient<FloodDatabase>): {
	wholeRows: number
	partialRows: number
	candidateRows: number
	resolutions: number[]
} {
	database.exec("CREATE INDEX build_cell_touch_zone_cell ON build_cell_touch (zone_code, h3_cell, is_full)")

	const zones = database
		.prepare("SELECT DISTINCT zone_code, resolution FROM build_cell_touch ORDER BY zone_code, resolution")
		.all() as Array<{ zone_code: string; resolution: number }>

	const insertCell = database.prepare(
		"INSERT INTO flood_zone_cell (h3_cell, resolution, zone_code, containment) VALUES (?, ?, ?, ?)"
	)

	const resolutions = new Set<number>()

	let wholeRows = 0
	let partialRows = 0

	// One group per (zone, resolution): `compactCells` takes a single resolution, and an adaptively-indexed layer has
	// several. Pooling them throws; compacting only the target group would silently drop every coarsened feature's
	// interior — the shape of failure this repo keeps writing down, because the artifact would still build.
	for (const { zone_code: zoneCode, resolution } of zones) {
		const wholeShort = database
			.prepare("SELECT DISTINCT h3_cell FROM build_cell_touch WHERE zone_code = ? AND resolution = ? AND is_full = 1")
			.all(zoneCode, resolution) as Array<{ h3_cell: number }>

		const compacted = compactCells(wholeShort.map((row) => expandShortCellInt(row.h3_cell, resolution)))

		database.exec("BEGIN")

		for (const cell of compacted) {
			const cellResolution = getResolution(cell)

			resolutions.add(cellResolution)
			insertCell.run(shortCellToInt(cell as H3Cell), cellResolution, zoneCode, FloodCellContainment.Whole)

			wholeRows++
		}

		database.exec("COMMIT")

		const partial = database
			.prepare(
				"SELECT DISTINCT t.h3_cell FROM build_cell_touch t WHERE t.zone_code = ? AND t.resolution = ? AND NOT EXISTS (" +
					"SELECT 1 FROM build_cell_touch f WHERE f.zone_code = t.zone_code AND f.h3_cell = t.h3_cell AND f.is_full = 1)"
			)
			.all(zoneCode, resolution) as Array<{ h3_cell: number }>

		database.exec("BEGIN")

		for (const row of partial) {
			resolutions.add(resolution)
			insertCell.run(row.h3_cell, resolution, zoneCode, FloodCellContainment.Partial)

			partialRows++
		}

		database.exec("COMMIT")
	}

	// The candidate list exists for the fringe only: a whole cell is answered by `flood_zone_cell` alone, so carrying its
	// polygons would store the geometry join for every interior cell in England to no purpose.
	database.exec(
		"INSERT INTO flood_zone_cell_area (h3_cell, resolution, area_id) " +
			"SELECT DISTINCT t.h3_cell, t.resolution, t.area_id FROM build_cell_touch t " +
			"WHERE EXISTS (SELECT 1 FROM flood_zone_cell c WHERE c.h3_cell = t.h3_cell AND c.zone_code = t.zone_code AND c.containment = 'partial')"
	)

	const candidateRows = (database.prepare("SELECT count(*) AS n FROM flood_zone_cell_area").get() as { n: number }).n

	return {
		wholeRows,
		partialRows,
		candidateRows,
		resolutions: [...resolutions].toSorted((left, right) => left - right),
	}
}

/**
 * The coverage rows: one per interior cell of the authority's footprint, and none outside it.
 *
 * `observed_rows` counts the polygons reaching into the cell, which is what the contract's column means. It is ZERO for
 * a cell the authority designated and no polygon covers — the storable form of the Zone 1 designation, and the row a
 * reader must not confuse with the absent row a cell outside England has.
 */
function buildCoverageCells(extent: FloodMapExtent, observed: Map<number, number>): CoverageCell[] {
	return designatedCoverageCells(extent.coverageCells, observed)
}

/**
 * Insert the single footprint row.
 */
function writeExtentRow(
	database: DatabaseClient<FloodDatabase>,
	options: BuildFloodOptions,
	coverageCells: number
): void {
	const { extent } = options

	database
		.prepare(
			"INSERT INTO flood_map_extent (extent_id, status, authority, statement, statement_url, boundary_source, boundary_source_url, boundary_vintage, boundary_license, effective_date, min_lat, min_lon, max_lat, max_lon, coverage_cells, coverage_resolution) " +
				"VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
		)
		.run(
			extent.extentID,
			extent.status,
			extent.authority,
			extent.statement,
			extent.statementURL,
			extent.boundary.source,
			extent.boundary.sourceURL,
			extent.boundary.vintage,
			extent.boundary.license,
			options.sourceVintage,
			extent.bbox.minLat,
			extent.bbox.minLon,
			extent.bbox.maxLat,
			extent.bbox.maxLon,
			coverageCells,
			extent.coverageResolution
		)
}

/**
 * Insert the authority's declared zone domain.
 */
function writeVocabularyRows(database: DatabaseClient<FloodDatabase>): void {
	const insert = database.prepare(
		"INSERT INTO flood_zone_vocabulary (zone_code, label, definition, definition_url) VALUES (?, ?, ?, ?)"
	)

	for (const zone of EA_FLOOD_ZONE_DEFINITIONS) {
		insert.run(zone.code, zone.label, zone.definition, zone.definitionURL)
	}
}
