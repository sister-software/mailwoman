/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   This module processes a source range as a streaming pass. It writes every feature to `flood_zone_area`
 *   and to the build's touch table.
 *
 *   This work runs in chunks because h3's wasm heap cannot be reset from JavaScript.
 *   It also fails after an unbounded number of polyfill calls. In the production input, runs died after
 *   roughly 510,000 and 798,000 features on geometry that classifies in milliseconds in a fresh process.
 *   A build that completes only when fragmentation happens to stay low is not a reproducible build, so
 *   {@linkcode buildFloodDatabase} bounds classification by running one chunk for each range of authority feature ids.
 *   It runs each chunk in a separate process, so each starts with an empty heap. The call-removal shortcuts in `cells.ts`
 *   improve speed. Chunks provide the correctness guarantee.
 *
 *   The chunk appends rows to a database created and sealed by its parent. It returns counts for the parent to add.
 *   Chunks run sequentially against the file, so the build has one writer and requires no locking.
 */

import { stringifyJSON } from "@mailwoman/core/json"
import {
	addCoverageCells,
	encodeRings,
	ringAreaReadings,
	ringsBoundingBox,
	shortCellToInt,
	classifyFeatureCells,
} from "@mailwoman/spatial"
import { beginBatched } from "@mailwoman/sqlite/batched"
import type { DatabaseClient } from "@mailwoman/sqlite/client"

import type { FloodDatabase } from "#schema"
import type { FloodFeatureSource } from "#sdk/ingest/index"
import { EA_FLOOD_ZONE_CODES } from "#vocabulary"

/**
 * Rows per bulk-insert transaction.
 *
 * Chosen for the geometry table because each row contains a blob.
 * A larger transaction grows the write-ahead file without improving throughput.
 */
const INSERT_TRANSACTION_ROWS = 5000

/**
 * Features between progress reports.
 */
const PROGRESS_STRIDE = 50_000

/**
 * What one chunk produced.
 *
 * Every field is JSON-serializable, because a chunk normally reports across a process boundary.
 */
export interface FloodChunkResult {
	features: number
	/**
	 * Features whose bounding box forced a resolution coarser than the target.
	 */
	coarsened: number
	zoneCounts: Record<string, number>
	/**
	 * `[coverageCell, polygonsReachingIt]` pairs — an array rather than a `Map`
	 * so it survives the process boundary.
	 */
	observedByCoverageCell: Array<[number, number]>
	/**
	 * Square metres for three areas: the source's figure and encoded rings with holes or without holes.
	 */
	area: { sourceM2: number; nestedM2: number; allExteriorM2: number }
}

export interface IngestFloodChunkOptions {
	source: FloodFeatureSource
	indexResolution: number
	coverageResolution: number
	onProgress?: (message: string) => void
}

/**
 * Stream one chunk of the source into `database`.
 *
 * @throws {Error} On a zone code outside the authority's declared domain,
 * or on a feature the classifier refuses.
 */
export async function ingestFloodChunk(
	database: DatabaseClient<FloodDatabase>,
	options: IngestFloodChunkOptions
): Promise<FloodChunkResult> {
	const insertArea = database.prepare(
		"INSERT INTO flood_zone_area (area_id, zone_code, zone_subtype, zone_source, origin, panel_id, effective_date, min_lat, min_lon, max_lat, max_lon, rings) " +
			"VALUES (?, ?, NULL, ?, ?, NULL, NULL, ?, ?, ?, ?, ?)"
	)

	const insertTouch = database.prepare(
		"INSERT INTO build_cell_touch (h3_cell, resolution, zone_code, area_id, is_full) VALUES (?, ?, ?, ?, ?)"
	)

	const zoneCounts: Record<string, number> = {}
	const observedByCoverageCell = new Map<number, number>()

	let features = 0
	let coarsened = 0
	let sourceArea = 0
	let nestedArea = 0
	let allExteriorArea = 0

	const batch = beginBatched(database, { rowsPerCommit: INSERT_TRANSACTION_ROWS })

	try {
		for await (const feature of options.source.features()) {
			if (!EA_FLOOD_ZONE_CODES.has(feature.zoneCode)) {
				throw new Error(
					`flood build: feature ${feature.areaID} carries zone code ${stringifyJSON(feature.zoneCode)}, which is not in the authority's declared domain (${[...EA_FLOOD_ZONE_CODES].join(", ")}) — an unknown code is a source-schema change, and coercing it would turn "the source changed" into "there is nothing here"`
				)
			}

			const bbox = ringsBoundingBox(feature.polygons)
			const areas = ringAreaReadings(feature.polygons)

			sourceArea += feature.sourceAreaM2
			nestedArea += areas.nested
			allExteriorArea += areas.allExterior

			insertArea.run(
				feature.areaID,
				feature.zoneCode,
				feature.zoneSource,
				feature.origin,
				bbox.minLat,
				bbox.minLon,
				bbox.maxLat,
				bbox.maxLon,
				encodeRings(feature.polygons)
			)

			const classified = classifyFeatureCells(feature.polygons, options.indexResolution, feature.areaID, "flood cells")

			if (classified.resolution !== options.indexResolution) {
				coarsened++
			}

			const coverageCells = new Set<number>()

			for (const cell of classified.whole) {
				insertTouch.run(shortCellToInt(cell), classified.resolution, feature.zoneCode, feature.areaID, 1)
				addCoverageCells(coverageCells, cell, classified.resolution, options.coverageResolution)
			}

			for (const cell of classified.partial) {
				insertTouch.run(shortCellToInt(cell), classified.resolution, feature.zoneCode, feature.areaID, 0)
				addCoverageCells(coverageCells, cell, classified.resolution, options.coverageResolution)
			}

			for (const coverageCell of coverageCells) {
				observedByCoverageCell.set(coverageCell, (observedByCoverageCell.get(coverageCell) ?? 0) + 1)
			}

			zoneCounts[feature.zoneCode] = (zoneCounts[feature.zoneCode] ?? 0) + 1

			features++

			batch.rowWritten()

			if (features % PROGRESS_STRIDE === 0) {
				options.onProgress?.(`${features.toLocaleString()} features in this chunk`)
			}
		}

		batch.commit()
	} catch (error) {
		batch.rollbackQuietly()

		throw error
	}

	return {
		features,
		coarsened,
		zoneCounts,
		observedByCoverageCell: [...observedByCoverageCell],
		area: { sourceM2: sourceArea, nestedM2: nestedArea, allExteriorM2: allExteriorArea },
	}
}
