/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The `partial` share cannot choose between candidate resolutions, so each is reported by candidates per cell and by the polyfill-only zero-cell count.
 */

import type { ResolutionMeasurementOptions } from "@mailwoman/core/layers"
import { classifyFeatureCells } from "@mailwoman/spatial"

import { polyfillFindsNothing, ZoningCellIndex, type CellIndexMeasurement } from "#sdk/cells"
import { readZoningFeatures, readZoningSourceIdentity, type ZoningIngestOptions } from "#sdk/ingest/index"

export interface MeasureResolutionsOptions extends ZoningIngestOptions, ResolutionMeasurementOptions {
	/**
	 * Also runs a centre-in-polygon polyfill per feature per resolution at the cost of one extra h3 call per feature.
	 */
	measurePolyfill?: boolean
}

export interface ResolutionMeasurementReport {
	features: number
	/**
	 * The count the source declares for itself; a run whose streamed total differs read a truncated file.
	 */
	declaredFeatureCount: number
	measurements: CellIndexMeasurement[]
}

const DEFAULT_PROGRESS_EVERY = 5000

/**
 * Measure every candidate resolution over the real source.
 *
 * @throws {Error} When the streamed feature count does not match the count the source declares.
 */
export async function measureZoningCellResolutions(
	options: MeasureResolutionsOptions
): Promise<ResolutionMeasurementReport> {
	const identity = await readZoningSourceIdentity(options)
	const indexes = options.resolutions.map((resolution) => new ZoningCellIndex(resolution))
	const progressEvery = options.progressEvery ?? DEFAULT_PROGRESS_EVERY
	const measurePolyfill = options.measurePolyfill ?? true

	let features = 0

	for await (const feature of readZoningFeatures(options)) {
		for (const index of indexes) {
			index.add(classifyFeatureCells(feature.rings.polygons, index.resolution, feature.areaID, "zoning cells"))

			if (measurePolyfill) {
				index.addPolyfillProbe(polyfillFindsNothing(feature.rings.polygons, index.resolution))
			}
		}

		features++

		if (features % progressEvery === 0) {
			options.onProgress?.(`${features.toLocaleString()} features classified`)
		}
	}

	// A range or authority selector narrows the population on purpose, so the declared total is only checked on a whole pass.
	const narrowed =
		options.limit !== undefined || options.authorityCode !== undefined || options.objectIDFrom !== undefined

	if (!narrowed && features !== identity.featureCount) {
		throw new Error(
			`zoning measure: streamed ${features} features, the source declares ${identity.featureCount} — a short read reports a smaller country rather than failing`
		)
	}

	return {
		features,
		declaredFeatureCount: identity.featureCount,
		measurements: indexes.map((index) => index.finish()),
	}
}

export { formatResolutionRows } from "#sdk/cells"
