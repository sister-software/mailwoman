/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Each resolution holds its own cell sets and the finest candidate dominates memory, so a caller that
 * runs out of headroom runs the candidates in separate invocations.
 */

import type { ResolutionMeasurementOptions } from "@mailwoman/core/layers"
import { classifyFeatureCells } from "@mailwoman/spatial"

import { FloodCellIndex, type CellIndexMeasurement } from "#sdk/cells"
import { readFloodSourceFeatures, readFloodSourceIdentity, type FloodIngestOptions } from "#sdk/ingest/index"

export interface MeasureResolutionsOptions extends FloodIngestOptions, ResolutionMeasurementOptions {}

export interface ResolutionMeasurementReport {
	features: number
	/**
	 * The count the source declares for itself; a streamed total that differs means a truncated read.
	 */
	declaredFeatureCount: number
	measurements: CellIndexMeasurement[]
}

const DEFAULT_PROGRESS_EVERY = 50_000

/**
 * Measure every candidate resolution over the real source, throwing when the streamed
 * feature count does not match the count the source declares.
 */
export async function measureFloodCellResolutions(
	options: MeasureResolutionsOptions
): Promise<ResolutionMeasurementReport> {
	const identity = await readFloodSourceIdentity(options)
	const indexes = options.resolutions.map((resolution) => new FloodCellIndex(resolution))
	const progressEvery = options.progressEvery ?? DEFAULT_PROGRESS_EVERY

	let features = 0

	for await (const feature of readFloodSourceFeatures(options)) {
		for (const index of indexes) {
			index.add(
				feature.zoneCode,
				feature.areaID,
				classifyFeatureCells(feature.polygons, index.resolution, feature.areaID, "flood cells")
			)
		}

		features++

		if (features % progressEvery === 0) {
			options.onProgress?.(`${features.toLocaleString()} features classified`)
		}
	}

	const expected = options.limit ?? identity.featureCount

	if (features !== expected) {
		throw new Error(
			`flood measure: streamed ${features} features, the source declares ${expected} — a short read reports a smaller England rather than failing`
		)
	}

	return {
		features,
		declaredFeatureCount: identity.featureCount,
		measurements: indexes.map((index) => index.finish().measurement),
	}
}

/**
 * The measurement as markdown table rows, one line per element.
 */
export function formatResolutionMeasurementRows(measurements: readonly CellIndexMeasurement[]): string[] {
	return [
		"| res | touched cells | whole | partial | partial share | whole after compaction | candidate (cell, area) pairs | coarsened features |",
		"| --- | ------------- | ----- | ------- | ------------- | ---------------------- | --------------------------- | ------------------ |",
		...measurements.map(
			(m) =>
				`| ${m.resolution} | ${m.touchedCells.toLocaleString()} | ${m.wholeCells.toLocaleString()} | ` +
				`${m.partialCells.toLocaleString()} | ${(m.partialShare * 100).toFixed(1)}% | ` +
				`${m.compactedWholeCells.toLocaleString()} | ${m.candidatePairs.toLocaleString()} | ` +
				`${m.coarsenedFeatures.toLocaleString()} |`
		),
	]
}

/**
 * The same table as one string, for a log line.
 */
export function formatResolutionMeasurements(measurements: readonly CellIndexMeasurement[]): string {
	return formatResolutionMeasurementRows(measurements).join("\n")
}
