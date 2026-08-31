/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The cell index, and the measurement the index resolution is chosen from.
 *
 *   THE CLASSIFIER ITSELF LIVES IN `@mailwoman/spatial`, re-exported below so this package's call sites and
 *   its `@mailwoman/zoning/sdk/cells` subpath keep reading the same. `classifyFeatureCells`, the per-PART
 *   zero-cell guard and the allocator-avoiding shortcuts around it are properties of h3-js rather than of
 *   this product — the layer contract's polygon-builder section states them as requirements on EVERY polygon
 *   builder — and a second copy of the zero-cell guard is a second place for it to stop guarding.
 *
 *   WHAT THIS LAYER ADDS IS THE NUMBER THE RESOLUTION IS ACTUALLY CHOSEN FROM, AND IT IS NOT THE `partial`
 *   SHARE. The inherited size contract picks a resolution from the measured `partial` share, and for this
 *   subject that statistic carries no signal: computed over all 85,330 Irish features, the median zoning
 *   polygon is 4,497 m² against an average res-9 cell of 105,333 m², so 95.7% of them are smaller than a cell
 *   and the `partial` share is near 100% at every candidate. Two numbers do carry signal —
 *   CANDIDATES PER CELL, which is how much geometry a probe reads, and the POLYFILL-ONLY ZERO-CELL COUNT,
 *   which is how many features a centre-in-polygon index would have dropped — so both are measured here and
 *   the `partial` share is reported beside them rather than in place of them.
 *
 *   THE ZERO-CELL COUNT IS A MEASUREMENT OF THE ALTERNATIVE, NOT OF THIS INDEX. `classifyFeatureCells` takes
 *   overlapping containment and REFUSES a feature that reaches no cell, so this index's own zero-cell count is
 *   zero by construction. What the column reports is what `polygonToCells` — the centre-in-polygon polyfill a
 *   builder reaches for first — would have returned nothing for, and every one of those would have read
 *   downstream as an absence of zoning.
 */

import { compactAcrossResolutions, shortCellToInt, type FeatureCells, type H3Cell } from "@mailwoman/spatial"
import { polygonToCells } from "h3-js"

import type { MultiPolygonRings } from "#rings"

export {
	addCoverageCells,
	CELL_ESTIMATE_BUDGET,
	classifyFeatureCells,
	coverageCellFor,
	estimateCellCount,
	featureCellRows,
	MIN_INDEX_RESOLUTION,
	resolutionForFeature,
	type FeatureCells,
} from "@mailwoman/spatial"

/**
 * Would a CENTRE-IN-POLYGON polyfill return nothing for this feature?
 *
 * The measurement that forced this layer's index to take cell-touches-polygon: at resolution 9 `polygonToCells` returns
 * an empty set for the great majority of Irish zoning polygons, because no cell centre falls inside them. A builder
 * indexing only the polyfill output would drop every one of them silently.
 */
export function polyfillFindsNothing(polygons: MultiPolygonRings, resolution: number): boolean {
	for (const rings of polygons) {
		// `isGeoJSON = true`: the rings are already `[lon, lat]`, which is the order the ingest emits.
		if (polygonToCells(rings as number[][][], resolution, true).length) return false
	}

	return true
}

/**
 * What one resolution came out as over the whole set — the numbers the resolution choice is made from.
 */
export interface CellIndexMeasurement {
	resolution: number
	features: number
	/**
	 * Cells the layer reaches at all.
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
	 * `partialCells / touchedCells`. Reported, and NOT what the resolution is chosen on — see this file's header.
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
	 * How many polygons name a cell, over the cells the layer reaches. This is what a probe pays: a cell naming eight
	 * candidates is eight bounding-box tests and up to eight ray casts.
	 */
	candidatesPerCell: { mean: number; p90: number; max: number }
	/**
	 * Cells naming more than one polygon, and their share of the touched cells.
	 */
	multiCandidateCells: number
	multiCandidateShare: number
	/**
	 * Features a centre-in-polygon polyfill would have returned NOTHING for — see {@link polyfillFindsNothing}.
	 * `undefined` where the measurement did not run it.
	 */
	polyfillZeroCellFeatures?: number
	/**
	 * Features whose bounding box forced a coarser resolution than the target — see `CELL_ESTIMATE_BUDGET`.
	 */
	coarsenedFeatures: number
	/**
	 * Features this index returned no cell for. ZERO BY CONSTRUCTION: `classifyFeatureCells` throws rather than returning
	 * an empty set, so a non-zero value here means the guard was bypassed.
	 */
	zeroCellFeatures: number
}

/**
 * Accumulate one resolution's cell index over a stream of features.
 *
 * The whole set is held as short-cell STRINGS rather than the integers the tables store, because `compactCells` is an
 * h3-js function over full indexes and round-tripping at every step would cost more than the strings do. The candidate
 * counter is keyed by the 48-bit INTEGER instead: it is the larger of the two at every candidate resolution, and it is
 * never handed back to h3.
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

	/**
	 * Fold one feature's classification in.
	 */
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

	/**
	 * Record that a centre-in-polygon polyfill found nothing for one feature.
	 */
	addPolyfillProbe(foundNothing: boolean): void {
		this.#measuredPolyfill = true

		if (foundNothing) {
			this.#polyfillZeroCell++
		}
	}

	/**
	 * The measurement.
	 *
	 * The compacted count is an approximation of what the build stores and is reported as one: the build compacts each
	 * FEATURE's whole set, while this compacts the union of them. The union can only compact at least as far, so this is
	 * a lower bound on the stored row count — the direction a size estimate should err in — and the build's own receipt
	 * reports the real number.
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
				// Nearest-rank p90 over the candidate counts, which is the shape `@mailwoman/core/utils/stats` uses.
				p90: counts.length ? counts[Math.min(counts.length - 1, Math.ceil(0.9 * counts.length) - 1)]! : 0,
				max,
			},
			multiCandidateCells: multi,
			multiCandidateShare: touched ? multi / touched : 0,
			...(this.#measuredPolyfill ? { polyfillZeroCellFeatures: this.#polyfillZeroCell } : {}),
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
 * The measurement as markdown table ROWS — what a build receipt carries, one line per element so a caller printing them
 * never has to split a joined string back apart.
 *
 * THE ZERO-CELL COLUMN IS FIRST AFTER THE COUNTS, because it is the column the resolution is chosen on and the one a
 * reader most needs to see is not zero for the alternative index.
 */
export function formatResolutionRows(measurements: readonly CellIndexMeasurement[]): string[] {
	return [
		"| res | features | polyfill-only zero-cell | stored cell rows | touched cells | candidates/cell mean | p90 | max | cells >1 candidate | partial share | coarsened |",
		"| --- | -------- | ----------------------- | ---------------- | ------------- | -------------------- | --- | --- | ------------------ | ------------- | --------- |",
		...measurements.map(
			(measurement) =>
				`| ${measurement.resolution} | ${measurement.features.toLocaleString()} | ` +
				`${
					measurement.polyfillZeroCellFeatures === undefined
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
