/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The delineation-keyed cell index, plus the partial-cell and mixed-top-class shares that choose its resolution.
 */

import {
	classifyFeatureCells,
	compactAcrossResolutions,
	shortCellToInt,
	type FeatureCells,
	type H3Cell,
	type MultiPolygonRings,
} from "@mailwoman/spatial"
import { getResolution } from "h3-js"

/**
 * The label this layer's classifier failures carry.
 */
export const SOIL_CELL_LABEL = "soil cells"

/**
 * Classify one delineation — {@link classifyFeatureCells} with this layer's label bound.
 */
export function classifyDelineationCells(
	polygons: MultiPolygonRings,
	targetResolution: number,
	areaID: string
): FeatureCells {
	return classifyFeatureCells(polygons, targetResolution, areaID, SOIL_CELL_LABEL)
}

/**
 * What one resolution's index came out as.
 */
export interface SoilCellIndexMeasurement {
	resolution: number
	/**
	 * Cells the layer reaches at all.
	 */
	touchedCells: number
	/**
	 * Cells lying wholly inside a single delineation, before compaction.
	 */
	wholeCells: number
	/**
	 * Cells a delineation boundary crosses.
	 */
	partialCells: number
	/**
	 * `partialCells / touchedCells`, the share of in-layer probes that cannot
	 * be answered from the index alone.
	 */
	partialShare: number
	/**
	 * Whole cells after `compactCells`, expected to be close to `wholeCells` here
	 * because small delineations do not produce a uniform interior.
	 */
	compactedWholeCells: number
	/**
	 * `(cell, delineation)` pairs the index stores.
	 */
	cellDelineationPairs: number
	/**
	 * The mean number of delineations reaching a cell, which measures how mixed a cell is
	 * before any rating is read and rises as the resolution coarsens.
	 */
	meanDelineationsPerCell: number
	/**
	 * Delineations whose bounding box forced a coarser resolution than the target.
	 */
	coarsenedFeatures: number
	/**
	 * The resolutions actually present, finest last.
	 */
	resolutions: number[]
}

/**
 * Accumulates one resolution's cell index over a stream of delineations,
 * held as short-cell strings because `compactCells` needs full h3-js indexes
 * and round-tripping through the integer form would cost more.
 */
export class SoilCellIndex {
	readonly resolution: number

	readonly #whole = new Set<string>()
	readonly #touched = new Set<string>()
	/**
	 * `cell → delineation ids` for every touched cell, so the mean is over the
	 * real population rather than the fringe alone.
	 */
	readonly #byCell = new Map<string, Set<string>>()

	#coarsened = 0

	constructor(resolution: number) {
		this.resolution = resolution
	}

	/**
	 * Fold one delineation's classification in.
	 */
	add(areaID: string, cells: FeatureCells): void {
		if (cells.resolution !== this.resolution) {
			this.#coarsened++
		}

		for (const cell of cells.whole) {
			this.#whole.add(cell)
			this.#record(cell, areaID)
		}

		for (const cell of cells.partial) {
			this.#record(cell, areaID)
		}
	}

	#record(cell: string, areaID: string): void {
		this.#touched.add(cell)

		let areas = this.#byCell.get(cell)

		if (!areas) {
			areas = new Set()

			this.#byCell.set(cell, areas)
		}

		areas.add(areaID)
	}

	/**
	 * Compacts the whole-cell set and reports the measurement, applying compaction to the
	 * whole set only because a partial cell's parent would claim fringe ground.
	 */
	finish(): SoilCellIndexMeasurement {
		const compacted = compactAcrossResolutions(this.#whole)

		const resolutions = new Set<number>()

		for (const cell of this.#touched) {
			resolutions.add(getResolution(cell))
		}

		let pairs = 0

		for (const areas of this.#byCell.values()) {
			pairs += areas.size
		}

		const touched = this.#touched.size
		const partial = touched - this.#whole.size

		return {
			resolution: this.resolution,
			touchedCells: touched,
			wholeCells: this.#whole.size,
			partialCells: partial,
			partialShare: touched ? partial / touched : 0,
			compactedWholeCells: compacted.length,
			cellDelineationPairs: pairs,
			meanDelineationsPerCell: touched ? pairs / touched : 0,
			coarsenedFeatures: this.#coarsened,
			resolutions: [...resolutions].toSorted((left, right) => left - right),
		}
	}
}

/**
 * The measurement as markdown table rows, one line per element so a caller never
 * has to split a joined string back apart.
 */
export function formatSoilResolutionRows(
	measurements: ReadonlyArray<SoilCellIndexMeasurement & { mixedCellShare?: number }>
): string[] {
	return [
		"| res | touched cells | whole | partial | partial share | whole after compaction | (cell, delineation) pairs | mean delineations/cell | top class under half |",
		"| --- | ------------- | ----- | ------- | ------------- | ---------------------- | ------------------------- | ---------------------- | -------------------- |",
		...measurements.map(
			(m) =>
				`| ${m.resolution} | ${m.touchedCells.toLocaleString()} | ${m.wholeCells.toLocaleString()} | ` +
				`${m.partialCells.toLocaleString()} | ${(m.partialShare * 100).toFixed(1)}% | ` +
				`${m.compactedWholeCells.toLocaleString()} | ${m.cellDelineationPairs.toLocaleString()} | ` +
				`${m.meanDelineationsPerCell.toFixed(2)} | ` +
				`${m.mixedCellShare === undefined ? "—" : `${(m.mixedCellShare * 100).toFixed(1)}%`} |`
		),
	]
}

/**
 * The cell integer a short-cell string stores as.
 */
export function cellToShortInt(cell: string): number {
	return shortCellToInt(cell as H3Cell)
}
