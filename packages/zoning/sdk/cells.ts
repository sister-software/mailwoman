/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * The cell classifier lives in `@mailwoman/spatial`, and this layer adds the candidates-per-cell and polyfill-only zero-cell measurements the resolution is chosen from.
 */

import {
	compactAcrossResolutions,
	shortCellToInt,
	type FeatureCells,
	type H3Cell,
	type MultiPolygonRings,
} from "@mailwoman/spatial"
import { polygonToCells } from "h3-js"

/**
 * Whether a center-in-polygon polyfill would return no cell for this feature,
 * the measurement that forced the index to take cell-touches-polygon.
 */
export function polyfillFindsNothing(polygons: MultiPolygonRings, resolution: number): boolean {
	for (const rings of polygons) {
		// `isGeoJSON = true`: the rings are already `[lon, lat]`.
		if (polygonToCells(rings as number[][][], resolution, true).length) return false
	}

	return true
}

/**
 * What one resolution came out as over the whole set, the numbers the resolution choice is made from.
 */
export interface CellIndexMeasurement {
	resolution: number
	features: number

	touchedCells: number
	/**
	 * Cells answered by the index by itself, before compaction.
	 */
	wholeCells: number
	/**
	 * Cells needing the ray cast.
	 */
	partialCells: number
	/**
	 * `partialCells / touchedCells`, reported rather than chosen on.
	 */
	partialShare: number
	/**
	 * Whole cells after per-feature `compactCells` — the rows actually stored on the whole side.
	 */
	compactedWholeCells: number
	/**
	 * Cell rows the artifact would store at this resolution: the compacted whole rows plus the partial rows.
	 */
	storedCellRows: number
	/**
	 * Polygon count per cell across all cells the layer reaches.
	 * A probe pays this cost.
	 */
	candidatesPerCell: { mean: number; p90: number; max: number }
	/**
	 * Count of cells naming more than one polygon and their share among touched cells.
	 */
	multiCandidateCells: number
	multiCandidateShare: number
	/**
	 * Features a center-in-polygon polyfill would have returned no cell for —
	 * see {@link polyfillFindsNothing} — and `null` where the measurement did not run it.
	 */
	polyfillZeroCellFeatures: number | null
	/**
	 * Features whose bounding box forced a coarser resolution than the target — see `CELL_ESTIMATE_BUDGET`.
	 */
	coarsenedFeatures: number
	/**
	 * Features this index returned no cell for, always zero while `classifyFeatureCells`
	 * throws rather than returning an empty set.
	 */
	zeroCellFeatures: number
}

/**
 * Accumulate one resolution's cell index over a stream of features, holding
 * whole cells as short-cell strings and the candidate counter by 48-bit integer
 * because `compactCells` is an h3-js function over full indexes.
 */
export class ZoningCellIndex {
	readonly resolution: number

	readonly #whole = new Set<string>()
	readonly #wholeShort = new Set<number>()
	readonly #candidates = new Map<number, number>()

	#features = 0
	#coarsened = 0
	#zeroCell = 0
	#polyfillZeroCell = 0
	#measuredPolyfill = false

	constructor(resolution: number) {
		this.resolution = resolution
	}

	add(cells: FeatureCells): void {
		this.#features++

		if (cells.resolution !== this.resolution) {
			this.#coarsened++
		}

		if (!cells.whole.length && !cells.partial.length) {
			this.#zeroCell++
		}

		for (const cell of cells.whole) {
			this.#whole.add(cell)
			this.#wholeShort.add(shortCellToInt(cell))
			this.#count(cell)
		}

		for (const cell of cells.partial) {
			this.#count(cell)
		}
	}

	addPolyfillProbe(foundNothing: boolean): void {
		this.#measuredPolyfill = true

		if (foundNothing) {
			this.#polyfillZeroCell++
		}
	}

	/**
	 * The measurement.
	 *
	 * Its compacted count is a lower bound on stored rows.
	 * The compaction uses the feature union rather than each feature.
	 */
	finish(): CellIndexMeasurement {
		const compacted = compactAcrossResolutions(this.#whole).length

		const counts: number[] = []
		let total = 0
		let max = 0
		let multi = 0
		let partial = 0

		for (const [cell, count] of this.#candidates) {
			counts.push(count)
			total += count

			if (count > max) {
				max = count
			}

			if (count > 1) {
				multi++
			}

			if (!this.#wholeShort.has(cell)) {
				partial++
			}
		}

		counts.sort((left, right) => left - right)

		const touched = this.#candidates.size

		return {
			resolution: this.resolution,
			features: this.#features,
			touchedCells: touched,
			wholeCells: this.#whole.size,
			partialCells: partial,
			partialShare: touched ? partial / touched : 0,
			compactedWholeCells: compacted,
			storedCellRows: compacted + partial,
			candidatesPerCell: {
				mean: touched ? total / touched : 0,
				// Nearest-rank p90 over candidate counts.
				// This matches `@mailwoman/core/stats`.
				p90: counts.length ? counts[Math.min(counts.length - 1, Math.ceil(0.9 * counts.length) - 1)]! : 0,
				max,
			},
			multiCandidateCells: multi,
			multiCandidateShare: touched ? multi / touched : 0,
			polyfillZeroCellFeatures: this.#measuredPolyfill ? this.#polyfillZeroCell : null,
			coarsenedFeatures: this.#coarsened,
			zeroCellFeatures: this.#zeroCell,
		}
	}

	#count(cell: H3Cell): void {
		const short = shortCellToInt(cell)

		this.#candidates.set(short, (this.#candidates.get(short) ?? 0) + 1)
	}
}

/**
 * The measurement as markdown table rows, one line per element, with the zero-cell column first
 * after the counts because it is the column the resolution is chosen on.
 */
export function formatResolutionRows(measurements: readonly CellIndexMeasurement[]): string[] {
	return [
		"| res | features | polyfill-only zero-cell | stored cell rows | touched cells | candidates/cell mean | p90 | max | cells >1 candidate | partial share | coarsened |",
		"| --- | -------- | ----------------------- | ---------------- | ------------- | -------------------- | --- | --- | ------------------ | ------------- | --------- |",
		...measurements.map(
			(measurement) =>
				`| ${measurement.resolution} | ${measurement.features.toLocaleString()} | ` +
				`${
					measurement.polyfillZeroCellFeatures === null
						? "not measured"
						: `${measurement.polyfillZeroCellFeatures.toLocaleString()} (${(
								(measurement.polyfillZeroCellFeatures / Math.max(1, measurement.features)) *
								100
							).toFixed(1)}%)`
				} | ` +
				`${measurement.storedCellRows.toLocaleString()} | ${measurement.touchedCells.toLocaleString()} | ` +
				`${measurement.candidatesPerCell.mean.toFixed(2)} | ${measurement.candidatesPerCell.p90} | ${measurement.candidatesPerCell.max} | ` +
				`${measurement.multiCandidateCells.toLocaleString()} (${(measurement.multiCandidateShare * 100).toFixed(1)}%) | ` +
				`${(measurement.partialShare * 100).toFixed(1)}% | ${measurement.coarsenedFeatures.toLocaleString()} |`
		),
	]
}
