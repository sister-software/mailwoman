/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The streaming pass — every feature into `flood_zone_area` and into the build's touch table — as a
 *   unit of work that can run over PART of the source.
 *
 *   WHY THIS IS A CHUNK RATHER THAN THE WHOLE FILE. h3's WASM heap cannot be reset from JavaScript, and
 *   it does not survive an unbounded number of polyfill calls: over the real product, runs died after
 *   roughly 510,000 and 798,000 features on geometry that classifies in milliseconds in a fresh process.
 *   A build that completes only when fragmentation happens to stay low is not a reproducible build, so
 *   the classification is bounded by construction — {@linkcode buildFloodDatabase} runs one of these per
 *   range of the authority's own feature ids, each in its own process, and each therefore against a heap
 *   that starts empty. The call-removal shortcuts in `cells.ts` make this faster; they are not what makes
 *   it correct.
 *
 *   THE CHUNK OWNS NO ARTIFACT. It appends rows to a database the parent created and will seal, and
 *   returns counts the parent adds up. Chunks run one at a time against that file, so there is no
 *   concurrent writer and no locking to reason about.
 */

import type { DatabaseSync } from "@mailwoman/platform/sqlite"
import { addCoverageCells, encodeRings, ringAreaReadings, ringsBoundingBox, shortCellToInt } from "@mailwoman/spatial"

import { EA_FLOOD_ZONE_CODES } from "../vocabulary.ts"
import { classifyFeatureCells } from "./cells.ts"
import type { FloodFeatureSource } from "./ingest.ts"

/**
 * Rows per bulk-insert transaction. Chosen for the geometry table, whose rows carry a blob: a larger transaction grows
 * the write-ahead file without improving throughput.
 */
const INSERT_TRANSACTION_ROWS = 5000

/**
 * Features between progress reports.
 */
const PROGRESS_STRIDE = 50_000

/**
 * What one chunk produced. Every field is JSON-serializable, because a chunk normally reports across a process
 * boundary.
 */
export interface FloodChunkResult {
	features: number
	/**
	 * Features whose bounding box forced a resolution coarser than the target.
	 */
	coarsened: number
	zoneCounts: Record<string, number>
	/**
	 * `[coverageCell, polygonsReachingIt]` pairs — an array rather than a `Map` so it survives the process boundary.
	 */
	observedByCoverageCell: Array<[number, number]>
	/**
	 * Square metres: the source's own figure, the encoded rings read WITH their holes, and read without.
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
 * @throws {Error} On a zone code outside the authority's declared domain, or on a feature the classifier refuses.
 */
export async function ingestFloodChunk(
	database: DatabaseSync,
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
	let pending = 0
	let coarsened = 0
	let sourceArea = 0
	let nestedArea = 0
	let allExteriorArea = 0

	database.exec("BEGIN")

	try {
		for await (const feature of options.source.features()) {
			if (!EA_FLOOD_ZONE_CODES.has(feature.zoneCode)) {
				throw new Error(
					`flood build: feature ${feature.areaID} carries zone code ${JSON.stringify(feature.zoneCode)}, which is not in the authority's declared domain (${[...EA_FLOOD_ZONE_CODES].join(", ")}) — an unknown code is a source-schema change, and coercing it would turn "the source changed" into "there is nothing here"`
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

			pending++

			if (pending >= INSERT_TRANSACTION_ROWS) {
				database.exec("COMMIT")
				database.exec("BEGIN")

				pending = 0
			}

			if (features % PROGRESS_STRIDE === 0) {
				options.onProgress?.(`${features.toLocaleString()} features in this chunk`)
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
		features,
		coarsened,
		zoneCounts,
		observedByCoverageCell: [...observedByCoverageCell],
		area: { sourceM2: sourceArea, nestedM2: nestedArea, allExteriorM2: allExteriorArea },
	}
}
