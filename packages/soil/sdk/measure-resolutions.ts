/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The index resolution is a MEASUREMENT this layer takes, not a number argued to.
 *
 *   ONE STREAM, EVERY RESOLUTION. Re-reading a survey area's shapefile per candidate buys nothing — the
 *   classification is per delineation, so every candidate index folds the same delineation in turn. The cost
 *   is memory: each resolution holds its own cell sets, and the finest candidate dominates.
 *
 *   THIS INSTRUMENT REPORTS THE FIRST OF THE TWO NUMBERS §4.7 NAMES — the `partial` cell share, plus the mean
 *   delineations per cell that drives it. The SECOND number, the share of cells whose top class holds less
 *   than half the cell, is not measurable here: it needs the attribute join and the area weighting, which
 *   are the build. So it comes off the SHIPPING ARTIFACT instead — {@linkcode buildSoilDatabase} counts it
 *   while it writes the rows, and the build receipt reports it. That is the flood layer's lesson applied:
 *   the number that describes the artifact is the one taken from the artifact.
 */

import { classifyDelineationCells, SoilCellIndex, type SoilCellIndexMeasurement } from "./cells.ts"
import { readSoilDelineations, readSoilSourceIdentity, type SoilIngestOptions } from "./ingest.ts"

export interface MeasureSoilResolutionsOptions extends SoilIngestOptions {
	/**
	 * The candidate resolutions to report.
	 */
	resolutions: readonly number[]
	onProgress?: (message: string) => void
	/**
	 * How often to report progress, in delineations.
	 */
	progressEvery?: number
}

export interface SoilResolutionReport {
	delineations: number
	/**
	 * The count the shapefile declares for itself. A run whose streamed total differs read a truncated file.
	 */
	declaredFeatureCount: number
	measurements: SoilCellIndexMeasurement[]
}

const DEFAULT_PROGRESS_EVERY = 5000

/**
 * Measure every candidate resolution over one survey area's real delineations.
 *
 * @throws {Error} When the streamed count does not match the count the shapefile declares. A short read produces a
 *   well-formed table describing a smaller county, which is the partial result that must throw.
 */
export async function measureSoilCellResolutions(
	options: MeasureSoilResolutionsOptions
): Promise<SoilResolutionReport> {
	const identity = await readSoilSourceIdentity(options)
	const indexes = options.resolutions.map((resolution) => new SoilCellIndex(resolution))
	const progressEvery = options.progressEvery ?? DEFAULT_PROGRESS_EVERY

	let delineations = 0

	for await (const delineation of readSoilDelineations({ ...options, bbox: identity.bbox })) {
		for (const index of indexes) {
			index.add(
				delineation.areaID,
				classifyDelineationCells(delineation.polygons, index.resolution, delineation.areaID)
			)
		}

		delineations++

		if (delineations % progressEvery === 0) {
			options.onProgress?.(`${delineations.toLocaleString()} delineations classified`)
		}
	}

	const expected = options.limit ?? identity.featureCount

	if (delineations !== expected) {
		throw new Error(
			`soil measure: streamed ${delineations} delineations, the shapefile declares ${expected} — a short read reports a smaller survey area rather than failing`
		)
	}

	return {
		delineations,
		declaredFeatureCount: identity.featureCount,
		measurements: indexes.map((index) => index.finish()),
	}
}
