/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { ResolutionMeasurementOptions } from "@mailwoman/core/layers"

import { classifyDelineationCells, SoilCellIndex, type SoilCellIndexMeasurement } from "#sdk/cells"
import { readSoilDelineations, readSoilSourceIdentity, type SoilIngestOptions } from "#sdk/ingest/index"

export interface MeasureSoilResolutionsOptions extends SoilIngestOptions, ResolutionMeasurementOptions {}

export interface SoilResolutionReport {
	delineations: number
	/**
	 * The count the shapefile declares for itself.
	 * A streamed total that differs read a truncated file.
	 */
	declaredFeatureCount: number
	measurements: SoilCellIndexMeasurement[]
}

const DEFAULT_PROGRESS_EVERY = 5000

/**
 * Measure every candidate resolution over one survey area's real delineations.
 *
 * @throws {Error} When the streamed count does not match the count the shapefile declares.
 * A short read produces a well-formed table describing a smaller county.
 * which is the partial result that must throw.
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
