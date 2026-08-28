/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The scenario-keyed cell index: one accumulator per scenario, and the measurement the index resolution is
 *   chosen from.
 *
 *   THE CLASSIFIER ITSELF LIVES IN `@mailwoman/spatial`, re-exported below so this package's call sites and
 *   its `@mailwoman/coastal/sdk/cells` subpath keep reading the same. `classifyFeatureCells`, the per-PART
 *   zero-cell guard and the allocator-avoiding shortcuts around it are properties of h3-js rather than of
 *   this product — the layer contract's polygon-builder section states them as requirements on EVERY polygon
 *   builder — and a second copy of the zero-cell guard is a second place for it to stop guarding.
 *
 *   WHAT STAYS HERE IS WHAT IS SCENARIO-SHAPED. The flood layer accumulates per zone code, because a flood
 *   answer is a code from a two-value domain; the soil layer accumulates per delineation and weights by
 *   covered area. An erosion answer is a SPECIFIC FRONTAGE POLYGON carrying its own distance, policy and
 *   defence, under one of twelve scenarios that must never be pooled — so this accumulates per (scenario,
 *   polygon) and reports per scenario.
 *
 *   THE MEASUREMENT IS PER SCENARIO AND NEVER POOLED, and that is not a reporting preference. The twelve
 *   scenario layers cover the same frontages with different extents, so a pooled `partial` share would
 *   average a present-day designation together with a 2105 projection and describe neither. The number that
 *   decides the resolution is the share within one scenario, because that is the population a scenario-scoped
 *   probe reads.
 */

import { groupCellsByResolution, type FeatureCells } from "@mailwoman/spatial"
import { compactCells } from "h3-js"

export {
	addCoverageCells,
	CELL_ESTIMATE_BUDGET,
	classifyFeatureCells,
	coverageCellFor,
	estimateCellCount,
	// The per-feature row builder is shared for the same reason the classifier is: compaction and the short-cell encoding
	// are h3 arithmetic rather than anything this product knows, and `@mailwoman/zoning` builds its rows the same way.
	featureCellRows,
	MIN_INDEX_RESOLUTION,
	resolutionForFeature,
	type FeatureCells,
} from "@mailwoman/spatial"

/**
 * One scenario's accumulated cell sets across every feature in it.
 */
interface ScenarioAccumulator {
	whole: Set<string>
	touched: Set<string>
	features: number
	coarsened: number
}

/**
 * What one scenario came out as at one resolution — the numbers the resolution choice is made from.
 */
export interface ScenarioCellMeasurement {
	scenarioKey: string
	features: number
	/**
	 * Cells this scenario reaches at all.
	 */
	touchedCells: number
	/**
	 * Cells answered by the index alone, before compaction.
	 */
	wholeCells: number
	/**
	 * Cells needing the ray cast.
	 */
	partialCells: number
	/**
	 * `partialCells / touchedCells`. The share of in-layer probes that cannot be answered from the index alone.
	 */
	partialShare: number
	/**
	 * Whole cells after per-feature `compactCells` — the rows actually stored on the whole side.
	 */
	compactedWholeCells: number
	/**
	 * Features whose bounding box forced a coarser resolution than the target — see `CELL_ESTIMATE_BUDGET`.
	 */
	coarsenedFeatures: number
}

/**
 * One resolution's table across every scenario, plus the totals a size question is answered from.
 */
export interface CellIndexMeasurement {
	resolution: number
	perScenario: ScenarioCellMeasurement[]
	/**
	 * Cell rows the artifact would store at this resolution, across every scenario — the compacted whole rows plus the
	 * partial rows. This is the artifact's size, and it is a SUM over scenarios rather than a union: two scenarios naming
	 * the same cell are two rows, because they are two different claims.
	 */
	storedCellRows: number
	/**
	 * Cells reached across every scenario, summed the same way.
	 */
	touchedCells: number
	partialCells: number
	/**
	 * `partialCells / touchedCells` pooled. Reported for the size question only; the resolution is chosen on the
	 * per-scenario shares above.
	 */
	pooledPartialShare: number
}

/**
 * Accumulate one resolution's cell index over a stream of features, keeping the scenarios apart.
 *
 * Held as short-cell STRINGS rather than the integers the tables store, because `compactCells` and `cellToParent` are
 * h3-js functions over full indexes and round-tripping through the integer form at every step would cost more than the
 * strings do.
 */
export class CoastalCellIndex {
	readonly resolution: number

	readonly #scenarios = new Map<string, ScenarioAccumulator>()

	constructor(resolution: number) {
		this.resolution = resolution
	}

	/**
	 * Fold one feature's classification in, under its own scenario.
	 */
	add(scenarioKey: string, cells: FeatureCells): void {
		let scenario = this.#scenarios.get(scenarioKey)

		if (!scenario) {
			scenario = { whole: new Set(), touched: new Set(), features: 0, coarsened: 0 }

			this.#scenarios.set(scenarioKey, scenario)
		}

		scenario.features++

		if (cells.resolution !== this.resolution) {
			scenario.coarsened++
		}

		for (const cell of cells.whole) {
			scenario.whole.add(cell)
			scenario.touched.add(cell)
		}

		for (const cell of cells.partial) {
			scenario.touched.add(cell)
		}
	}

	/**
	 * The measurement, per scenario and then pooled.
	 *
	 * The compacted count here is an approximation of what the build stores and is reported as one: the build compacts
	 * each FEATURE's whole set, while this compacts the scenario's union of them. The union can only compact at least as
	 * far, so this is a lower bound on the stored row count — which is the direction a size estimate should err in, and
	 * the build's own receipt reports the real number.
	 */
	finish(): CellIndexMeasurement {
		const perScenario: ScenarioCellMeasurement[] = []

		let storedCellRows = 0
		let touchedTotal = 0
		let partialTotal = 0

		for (const [scenarioKey, scenario] of [...this.#scenarios].toSorted(([left], [right]) => (left < right ? -1 : 1))) {
			// `compactCells` takes one resolution at a time, and a coarsened feature's cells are at another — so the whole
			// set is grouped before compaction rather than pooled. Pooling would throw; compacting the target-resolution
			// group alone would silently drop every coarsened feature's interior.
			let compacted = 0

			for (const group of groupCellsByResolution(scenario.whole)) {
				compacted += compactCells(group).length
			}

			let partial = 0

			for (const cell of scenario.touched) {
				if (!scenario.whole.has(cell)) {
					partial++
				}
			}

			perScenario.push({
				scenarioKey,
				features: scenario.features,
				touchedCells: scenario.touched.size,
				wholeCells: scenario.whole.size,
				partialCells: partial,
				partialShare: scenario.touched.size ? partial / scenario.touched.size : 0,
				compactedWholeCells: compacted,
				coarsenedFeatures: scenario.coarsened,
			})

			storedCellRows += compacted + partial
			touchedTotal += scenario.touched.size
			partialTotal += partial
		}

		return {
			resolution: this.resolution,
			perScenario,
			storedCellRows,
			touchedCells: touchedTotal,
			partialCells: partialTotal,
			pooledPartialShare: touchedTotal ? partialTotal / touchedTotal : 0,
		}
	}
}

/**
 * The per-scenario measurement as markdown table ROWS — what a build receipt carries, one line per element so a caller
 * printing them never has to split a joined string back apart.
 */
export function formatScenarioMeasurementRows(measurements: readonly CellIndexMeasurement[]): string[] {
	const lines = [
		"| res | scenario | features | touched cells | whole | partial | partial share | whole after compaction | coarsened |",
		"| --- | -------- | -------- | ------------- | ----- | ------- | ------------- | ---------------------- | --------- |",
	]

	for (const measurement of measurements) {
		for (const scenario of measurement.perScenario) {
			lines.push(
				`| ${measurement.resolution} | ${scenario.scenarioKey} | ${scenario.features.toLocaleString()} | ` +
					`${scenario.touchedCells.toLocaleString()} | ${scenario.wholeCells.toLocaleString()} | ` +
					`${scenario.partialCells.toLocaleString()} | ${(scenario.partialShare * 100).toFixed(1)}% | ` +
					`${scenario.compactedWholeCells.toLocaleString()} | ${scenario.coarsenedFeatures.toLocaleString()} |`
			)
		}
	}

	return lines
}

/**
 * The per-resolution totals, which is the size question rather than the containment one.
 */
export function formatResolutionTotalRows(measurements: readonly CellIndexMeasurement[]): string[] {
	return [
		"| res | stored cell rows (all scenarios) | touched cells | partial | pooled partial share |",
		"| --- | ------------------------------- | ------------- | ------- | -------------------- |",
		...measurements.map(
			(measurement) =>
				`| ${measurement.resolution} | ${measurement.storedCellRows.toLocaleString()} | ` +
				`${measurement.touchedCells.toLocaleString()} | ${measurement.partialCells.toLocaleString()} | ` +
				`${(measurement.pooledPartialShare * 100).toFixed(1)}% |`
		),
	]
}
