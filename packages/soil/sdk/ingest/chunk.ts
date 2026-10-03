/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   This streaming pass writes each delineation to `soil_map_unit_area` and the build's touch table.
 *   It can process part of one survey area as a unit of work.
 *
 *   H3's wasm heap cannot be reset from JavaScript. It also cannot sustain unlimited polyfill calls.
 *   Two runs over the flood layer's real product stopped after roughly 510,000 and 798,000 features.
 *   The same geometries classify in milliseconds in a fresh process. A build that completes only when
 *   fragmentation stays low is not reproducible. {@linkcode buildSoilDatabase} bounds each process to a range
 *   of the shapefile's FIDs. Each range gets a separate process with a fresh heap. Iowa's 99 survey areas
 *   contain far more delineations together than each area contains by itself. The bound therefore applies per range.
 *
 *   The chunk appends rows to a database created by the parent. The parent seals that database and adds up
 *   the counts returned by each chunk. Chunks run one at a time against the file, so only one writer uses it.
 */

import { addCoverageCells, encodeRings, ringAreaReadings, ringsBoundingBox, shortCellToInt } from "@mailwoman/spatial"
import { beginBatched } from "@mailwoman/sqlite/batched"
import type { DatabaseClient } from "@mailwoman/sqlite/client"

import type { SoilDatabase } from "#schema"
import { classifyDelineationCells } from "#sdk/cells"
import type { SoilFeatureSource } from "#sdk/ingest"

/**
 * Rows per bulk-insert transaction.
 *
 * Chosen for the geometry table.
 * Each row contains a blob.
 *
 * A larger transaction grows the write-ahead file without improving throughput.
 */
const INSERT_TRANSACTION_ROWS = 5000

/**
 * Delineations between progress reports.
 */
const PROGRESS_STRIDE = 20_000

/**
 * What one chunk produced.
 *
 * Every field is JSON-serializable, because a chunk normally reports across a process boundary.
 */
export interface SoilChunkResult {
	areaSymbol: string
	delineations: number
	/**
	 * Delineations whose bounding box forced a resolution coarser than the target.
	 */
	coarsened: number
	/**
	 * `[coverageCell, delineationsReachingIt]` pairs — an array rather than a `Map`
	 * so it survives the process boundary.
	 */
	observedByCoverageCell: Array<[number, number]>
	/**
	 * The same, counting only delineations whose map unit has soil mapping behind it.
	 *
	 * Separate from the total because the coverage rule depends on this value.
	 * A cell reached only by `notcom` or access-denied polygons lies inside a published
	 * survey area and contains no digitized soil mapping.
	 *
	 * Section 3.2 of the survey specification assigns no row to that cell.
	 */
	mappedByCoverageCell: Array<[number, number]>
	/**
	 * Square meters computed from the encoded rings, with holes and with every ring treated as exterior.
	 */
	area: { nestedM2: number; allExteriorM2: number }
}

export interface IngestSoilChunkOptions {
	source: SoilFeatureSource
	indexResolution: number
	coverageResolution: number
	/**
	 * The map units with no soil mapping behind them — `notcom`, `notpub`,
	 * access denied, or no readable component weights.
	 *
	 * Passed in rather than joined here so the chunk stays a streaming pass over geometry.
	 */
	noMappingMukeys: ReadonlySet<string>
	onProgress?: (message: string) => void
}

/**
 * Stream one chunk of one survey area into `database`.
 *
 * @throws {Error} On a delineation the classifier refuses — which includes the
 * allocator's silent zero-cell answer.
 */
export async function ingestSoilChunk(
	database: DatabaseClient<SoilDatabase>,
	options: IngestSoilChunkOptions
): Promise<SoilChunkResult> {
	const insertArea = database.prepare(
		"INSERT INTO soil_map_unit_area (area_id, mukey, areasymbol, min_lat, min_lon, max_lat, max_lon, rings) " +
			"VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
	)

	const insertTouch = database.prepare(
		"INSERT INTO build_cell_touch (h3_cell, resolution, area_id, is_full) VALUES (?, ?, ?, ?)"
	)

	const observedByCoverageCell = new Map<number, number>()
	const mappedByCoverageCell = new Map<number, number>()

	let delineations = 0
	let coarsened = 0
	let nestedArea = 0
	let allExteriorArea = 0

	const batch = beginBatched(database, { rowsPerCommit: INSERT_TRANSACTION_ROWS })

	try {
		for await (const delineation of options.source.delineations()) {
			const bbox = ringsBoundingBox(delineation.polygons)
			const areas = ringAreaReadings(delineation.polygons)

			nestedArea += areas.nested
			allExteriorArea += areas.allExterior

			insertArea.run(
				delineation.areaID,
				delineation.mukey,
				delineation.areasymbol,
				bbox.minLat,
				bbox.minLon,
				bbox.maxLat,
				bbox.maxLon,
				encodeRings(delineation.polygons)
			)

			const classified = classifyDelineationCells(delineation.polygons, options.indexResolution, delineation.areaID)

			if (classified.resolution !== options.indexResolution) {
				coarsened++
			}

			const coverageCells = new Set<number>()

			for (const cell of classified.whole) {
				insertTouch.run(shortCellToInt(cell), classified.resolution, delineation.areaID, 1)
				addCoverageCells(coverageCells, cell, classified.resolution, options.coverageResolution)
			}

			for (const cell of classified.partial) {
				insertTouch.run(shortCellToInt(cell), classified.resolution, delineation.areaID, 0)
				addCoverageCells(coverageCells, cell, classified.resolution, options.coverageResolution)
			}

			const hasMapping = !options.noMappingMukeys.has(delineation.mukey)

			for (const coverageCell of coverageCells) {
				observedByCoverageCell.set(coverageCell, (observedByCoverageCell.get(coverageCell) ?? 0) + 1)

				if (hasMapping) {
					mappedByCoverageCell.set(coverageCell, (mappedByCoverageCell.get(coverageCell) ?? 0) + 1)
				}
			}

			delineations++

			batch.rowWritten()

			if (delineations % PROGRESS_STRIDE === 0) {
				options.onProgress?.(`${delineations.toLocaleString()} delineations in this chunk`)
			}
		}

		batch.commit()
	} catch (error) {
		batch.rollbackQuietly()

		throw error
	}

	return {
		areaSymbol: options.source.areaSymbol,
		delineations,
		coarsened,
		observedByCoverageCell: [...observedByCoverageCell],
		mappedByCoverageCell: [...mappedByCoverageCell],
		area: { nestedM2: nestedArea, allExteriorM2: allExteriorArea },
	}
}
