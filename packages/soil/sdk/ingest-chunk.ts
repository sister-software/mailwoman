/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The streaming pass — every delineation into `soil_map_unit_area` and into the build's touch table — as a
 *   unit of work that can run over PART of one survey area.
 *
 *   WHY THIS IS A CHUNK RATHER THAN A WHOLE FILE. h3's WASM heap cannot be reset from JavaScript, and it does
 *   not survive an unbounded number of polyfill calls: over the flood layer's real product, runs died after
 *   roughly 510,000 and 798,000 features on geometry that classifies in milliseconds in a fresh process. A
 *   build that completes only when fragmentation happens to stay low is not a reproducible build, so the
 *   classification is bounded by construction — {@linkcode buildSoilDatabase} runs one of these per range of
 *   the shapefile's own FIDs, each in its own process, and each therefore against a heap that starts empty.
 *   Iowa's 99 survey areas hold far more delineations together than any one of them does, which is why the
 *   bound is per RANGE rather than per area.
 *
 *   THE CHUNK OWNS NO ARTIFACT. It appends rows to a database the parent created and will seal, and returns
 *   counts the parent adds up. Chunks run one at a time against that file, so there is no concurrent writer
 *   and no locking to reason about.
 */

import type { DatabaseSync } from "@mailwoman/platform/sqlite"
import { addCoverageCells, encodeRings, ringAreaReadings, ringsBoundingBox, shortCellToInt } from "@mailwoman/spatial"
import type { DatabaseClient } from "@mailwoman/sqlite/client"

import type { SoilDatabase } from "../schema.ts"
import { classifyDelineationCells } from "./cells.ts"
import type { SoilFeatureSource } from "./ingest.ts"

/**
 * Rows per bulk-insert transaction. Chosen for the geometry table, whose rows carry a blob: a larger transaction grows
 * the write-ahead file without improving throughput.
 */
const INSERT_TRANSACTION_ROWS = 5000

/**
 * Delineations between progress reports.
 */
const PROGRESS_STRIDE = 20_000

/**
 * What one chunk produced. Every field is JSON-serializable, because a chunk normally reports across a process
 * boundary.
 */
export interface SoilChunkResult {
	areaSymbol: string
	delineations: number
	/**
	 * Delineations whose bounding box forced a resolution coarser than the target.
	 */
	coarsened: number
	/**
	 * `[coverageCell, delineationsReachingIt]` pairs — an array rather than a `Map` so it survives the process boundary.
	 */
	observedByCoverageCell: Array<[number, number]>
	/**
	 * The same, counting only delineations whose map unit HAS soil mapping behind it.
	 *
	 * Separate from the total because the coverage rule turns on it: a coverage cell reached only by `NOTCOM` and
	 * access-denied polygons is inside a published survey area and carries no digitized soil mapping, and the survey's
	 * §3.2 gives it no row.
	 */
	mappedByCoverageCell: Array<[number, number]>
	/**
	 * Square metres: the encoded rings read WITH their holes, and read without.
	 */
	area: { nestedM2: number; allExteriorM2: number }
}

export interface IngestSoilChunkOptions {
	source: SoilFeatureSource
	indexResolution: number
	coverageResolution: number
	/**
	 * The map units with NO soil mapping behind them — `NOTCOM`, `NOTPUB`, access denied, or no readable component
	 * weights. Passed in rather than joined here so the chunk stays a streaming pass over geometry.
	 */
	noMappingMukeys: ReadonlySet<string>
	onProgress?: (message: string) => void
}

/**
 * Stream one chunk of one survey area into `database`.
 *
 * @throws {Error} On a delineation the classifier refuses — which includes the allocator's silent zero-cell answer.
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
	let pending = 0
	let coarsened = 0
	let nestedArea = 0
	let allExteriorArea = 0

	database.exec("BEGIN")

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

			pending++

			if (pending >= INSERT_TRANSACTION_ROWS) {
				database.exec("COMMIT")
				database.exec("BEGIN")

				pending = 0
			}

			if (delineations % PROGRESS_STRIDE === 0) {
				options.onProgress?.(`${delineations.toLocaleString()} delineations in this chunk`)
			}
		}

		database.exec("COMMIT")
	} catch (error) {
		// Best-effort, and it must never replace the real error: the build runs with the journal off (nothing here is ever
		// published without the swap), so SQLite may refuse to unwind. What matters is that the caller sees WHY the ingest
		// stopped, not that a scratch file was tidied.
		try {
			database.exec("ROLLBACK")
		} catch {
			// The temp artifact is discarded either way.
		}

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
