/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The index resolution is a MEASUREMENT this layer takes, not a number argued to.
 *
 *   The share of cells that come out `partial` decides whether the index answers most probes on its own or
 *   whether the ray cast is the common path, and it is a property of England's coastal-frontage geometry that
 *   no reasoning about cell areas produces. This module streams the real source at each candidate resolution
 *   and reports the table the choice is made from; `build-coastal.ts` then builds at the chosen one.
 *
 *   THE TABLE IS PER SCENARIO AND THE POOLED ROW IS FOR SIZE ONLY. Twelve layers cover the same frontages
 *   with different extents; a pooled `partial` share averages a present-day designation together with a 2105
 *   projection and describes neither. What a scenario-scoped probe reads is one scenario's share, so that is
 *   the number the resolution is chosen on. The pooled total answers a different question — how many rows the
 *   artifact holds — and is reported separately rather than folded in.
 *
 *   ONE STREAM, EVERY RESOLUTION. Re-reading the geodatabase per candidate costs a full pass each and buys
 *   nothing — the classification is per feature, so every candidate index folds the same feature in turn. The
 *   cost is memory: each resolution holds its own cell sets, and the finest candidate dominates. A caller
 *   that runs out of headroom runs the candidates in separate invocations.
 */

import type { ResolutionMeasurementOptions } from "@mailwoman/core/layers"

import { classifyFeatureCells, CoastalCellIndex, type CellIndexMeasurement } from "#sdk/cells"
import { readCoastalScenarioFeatures, readCoastalSourceIdentity, type CoastalIngestOptions } from "#sdk/ingest"
import { NCERM_SCENARIOS_BY_KEY } from "#vocabulary"

export interface MeasureResolutionsOptions extends CoastalIngestOptions, ResolutionMeasurementOptions {
	/**
	 * Which scenarios to measure. Defaults to all twelve.
	 */
	scenarioKeys?: ReadonlyArray<string>
}

export interface ResolutionMeasurementReport {
	features: number
	/**
	 * The count each measured layer declares for itself. A run whose streamed total differs read a truncated file.
	 */
	declaredFeatureCounts: Record<string, number>
	measurements: CellIndexMeasurement[]
}

const DEFAULT_PROGRESS_EVERY = 2000

/**
 * Measure every candidate resolution over the real source, keeping the scenarios apart.
 *
 * @throws {Error} When a layer's streamed feature count does not match the count it declares. A short read produces a
 *   well-formed table describing a shorter coastline, which is the partial result that must throw.
 */
export async function measureCoastalCellResolutions(
	options: MeasureResolutionsOptions
): Promise<ResolutionMeasurementReport> {
	const scenarioKeys = options.scenarioKeys ?? [...NCERM_SCENARIOS_BY_KEY.keys()]
	const indexes = options.resolutions.map((resolution) => new CoastalCellIndex(resolution))
	const progressEvery = options.progressEvery ?? DEFAULT_PROGRESS_EVERY
	const declaredFeatureCounts: Record<string, number> = {}

	let features = 0

	for (const scenarioKey of scenarioKeys) {
		const scenario = NCERM_SCENARIOS_BY_KEY.get(scenarioKey)

		if (!scenario) {
			throw new Error(`coastal measure: ${JSON.stringify(scenarioKey)} is not one of the twelve published scenarios`)
		}

		const identity = await readCoastalSourceIdentity(scenario.layer, options)

		declaredFeatureCounts[scenario.layer] = identity.featureCount

		let streamedForLayer = 0

		for await (const feature of readCoastalScenarioFeatures(scenario, options)) {
			for (const index of indexes) {
				index.add(
					scenario.key,
					classifyFeatureCells(feature.polygons, index.resolution, feature.areaID, "coastal cells")
				)
			}

			features++

			streamedForLayer++

			if (features % progressEvery === 0) {
				options.onProgress?.(`${features.toLocaleString()} features classified (${scenario.key})`)
			}
		}

		const expected = options.limit ?? identity.featureCount

		if (streamedForLayer !== expected) {
			throw new Error(
				`coastal measure: ${scenario.layer} streamed ${streamedForLayer} features, the source declares ${expected} — a short read reports a shorter coastline rather than failing`
			)
		}
	}

	return {
		features,
		declaredFeatureCounts,
		measurements: indexes.map((index) => index.finish()),
	}
}

export { formatResolutionTotalRows, formatScenarioMeasurementRows } from "#sdk/cells"
