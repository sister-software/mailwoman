/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The index resolution is a MEASUREMENT this layer takes, not a number argued to — and for this subject the
 *   inherited size contract's own statistic is not the one that decides it.
 *
 *   THE `partial` SHARE CARRIES NO SIGNAL HERE, AND THAT WAS MEASURED. Computed over all 85,330 Irish
 *   features, the median zoning polygon is 4,497 m² against an average res-9 cell of 105,333 m²: 95.7% of
 *   them are smaller than a res-9 cell, 75.1% smaller than a res-10 cell and 34.5% smaller than a res-11 one.
 *   So the `partial` share sits near 100% at every candidate and cannot choose between them.
 *
 *   TWO NUMBERS CAN. CANDIDATES PER CELL is what a probe pays — a cell naming eight polygons is eight
 *   bounding-box tests and up to eight ray casts — and the POLYFILL-ONLY ZERO-CELL COUNT is how many features
 *   the obvious index would have dropped, each of which would read downstream as an absence of zoning. Both
 *   are reported per resolution and the `partial` share rides beside them.
 *
 *   ONE STREAM, EVERY RESOLUTION. Re-reading the export per candidate costs a full pass each and buys
 *   nothing — the classification is per feature, so every candidate index folds the same feature in turn. The
 *   cost is memory: each resolution holds its own cell sets, and the finest candidate dominates. A caller that
 *   runs out of headroom runs the candidates in separate invocations.
 */

import type { ResolutionMeasurementOptions } from "@mailwoman/core/layers"

import { polyfillFindsNothing, ZoningCellIndex, classifyFeatureCells, type CellIndexMeasurement } from "#sdk/cells"
import { readZoningFeatures, readZoningSourceIdentity, type ZoningIngestOptions } from "#sdk/ingest"

export interface MeasureResolutionsOptions extends ZoningIngestOptions, ResolutionMeasurementOptions {
	/**
	 * Also run a centre-in-polygon polyfill per feature per resolution, to report what a polyfill-only index would have
	 * dropped. On by default: it is the column the resolution is chosen on, and its cost is one extra h3 call per
	 * feature.
	 */
	measurePolyfill?: boolean
}

export interface ResolutionMeasurementReport {
	features: number
	/**
	 * The count the source declares for itself. A run whose streamed total differs read a truncated file.
	 */
	declaredFeatureCount: number
	measurements: CellIndexMeasurement[]
}

const DEFAULT_PROGRESS_EVERY = 5000

/**
 * Measure every candidate resolution over the real source.
 *
 * @throws {Error} When the streamed feature count does not match the count the source declares. A short read produces a
 *   well-formed table describing a smaller country, which is the partial result that must throw.
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

	// A RANGE or an authority selector narrows the population on purpose, so the declared total is only a check on a whole
	// pass. Narrowed runs report what they read and assert nothing about it.
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
