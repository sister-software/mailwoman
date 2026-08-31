/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The delineation-keyed cell index, and the two numbers the index resolution is chosen from.
 *
 *   THE CLASSIFIER ITSELF LIVES IN `@mailwoman/spatial`, because the traps it guards are properties of
 *   h3-js rather than of SSURGO: a centre-containment polyfill drops every polygon smaller than a cell, an
 *   exhausted WASM allocator reports success and returns zeros, and the allocator is sized from the
 *   bounding box. The layer contract states all three as requirements on every polygon builder. What is
 *   soil-shaped is the ACCUMULATOR below, which keys on the delineation rather than on a hazard class,
 *   because the reduction weights by the area a delineation covers.
 *
 *   EXPECT THE `partial` SHARE TO INVERT AGAINST THE FLOOD LAYER, AND DO NOT READ THAT AS A DEFECT. Flood
 *   polygons are large against their cells, so most cells fall wholly inside one zone and `compactCells`
 *   collapses long uniform interiors. Soil delineations are the opposite: 85.4% of `IA153`'s 17,966 of them
 *   are smaller than one resolution-9 cell, and the median is 24,863 m² against a 105,333 m² cell. Small
 *   polygons against large cells means most cells are crossed by a boundary — so the `partial` share should
 *   be HIGH, `compactCells` should yield close to nothing, and the index alone will rarely answer a point
 *   probe. That is not an argument against storing the geometry; it is the argument for why this layer
 *   carries the reduced `soil_capability_cell` alongside the index rather than relying on the index the way
 *   the flood layer can.
 *
 *   TWO NUMBERS GET REPORTED AT EACH CANDIDATE RESOLUTION, AND THEY MOVE IN OPPOSITE DIRECTIONS. The
 *   `partial` cell share says whether the containment index answers most probes alone. The share of cells
 *   whose top class holds less than half the cell says whether the layer is answering or hedging — the
 *   cell-grain analogue of NRCS's own `niccdcdpct` distribution, which reads 3.3% below half nationally.
 *   Going coarser improves the first and worsens the second, and picking between them is what the
 *   measurement is for.
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
	 * `partialCells / touchedCells` — the share of in-layer probes that cannot be answered from the index alone.
	 */
	partialShare: number
	/**
	 * Whole cells after `compactCells`. Expected to be close to `wholeCells` here rather than far below it: compaction
	 * needs a uniform interior, and small delineations do not produce one.
	 */
	compactedWholeCells: number
	/**
	 * `(cell, delineation)` pairs the index stores.
	 */
	cellDelineationPairs: number
	/**
	 * The mean number of delineations reaching a cell — the direct measure of how mixed a cell is before any rating is
	 * read, and the number that rises as the resolution coarsens.
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
 * Accumulate one resolution's cell index over a stream of delineations.
 *
 * Held as short-cell STRINGS rather than the integers the tables store, because `compactCells` is an h3-js function
 * over full indexes and round-tripping through the integer form at every step would cost more than the strings do.
 */
export class SoilCellIndex {
	readonly resolution: number

	readonly #whole = new Set<string>()
	readonly #touched = new Set<string>()
	/**
	 * `cell → delineation ids`. Every touched cell, so the mean below is over the real population rather than over the
	 * fringe alone.
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
	 * Compact the whole-cell set and report the measurement.
	 *
	 * Compaction is applied to the WHOLE set only — a partial cell's parent is not partial in any useful sense, and
	 * compacting it would claim the fringe covers ground it does not.
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
 * The measurement as markdown table ROWS — what a build receipt carries, one line per element so a caller printing them
 * never has to split a joined string back apart.
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
