/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The zone-keyed cell index: one accumulator per flood zone code, and the measurement the index
 *   resolution is chosen from.
 *
 *   THE CLASSIFIER ITSELF LIVES IN `@mailwoman/spatial`, re-exported below so this package's call sites and
 *   its `@mailwoman/flood/sdk/cells` subpath keep reading the same. `classifyFeatureCells` and the
 *   allocator-avoiding shortcuts around it are properties of h3-js rather than of this product — the layer
 *   contract's polygon-builder section states them as requirements on EVERY polygon builder — and a second
 *   copy of the zero-cell guard is a second place for it to stop guarding.
 *
 *   WHAT STAYS HERE IS WHAT IS ZONE-SHAPED. {@link FloodCellIndex} accumulates per zone code, because the
 *   question a reader asks of this layer is about the ZONE: a cell wholly inside any FZ3 polygon answers
 *   FZ3 whichever polygon that was. A soil layer accumulates per delineation and weights by covered area
 *   instead, so the accumulator is where the two layers genuinely differ and the classifier is where they
 *   do not.
 */

import { groupCellsByResolution, shortCellToInt, type FeatureCells, type H3Cell } from "@mailwoman/spatial"
import { compactCells, getResolution } from "h3-js"

export {
	addCoverageCells,
	CELL_ESTIMATE_BUDGET,
	classifyFeatureCells,
	coverageCellFor,
	estimateCellCount,
	MIN_INDEX_RESOLUTION,
	resolutionForFeature,
	type FeatureCells,
} from "@mailwoman/spatial"

/**
 * A zone's accumulated cell sets across every feature carrying that zone code.
 */
interface ZoneAccumulator {
	whole: Set<string>
	touched: Set<string>
}

/**
 * What one resolution's index came out as — the numbers the resolution choice is made from.
 */
export interface CellIndexMeasurement {
	resolution: number
	/**
	 * Cells the layer reaches at all, across every zone.
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
	 * `partialCells / touchedCells`. The number the resolution is chosen on: it is the share of in-layer probes that
	 * cannot be answered from the index alone.
	 */
	partialShare: number
	/**
	 * Whole cells after `compactCells` — the rows actually stored.
	 */
	compactedWholeCells: number
	/**
	 * `(cell, area)` pairs the partial tier stores.
	 */
	candidatePairs: number
	/**
	 * Features whose bounding box forced a coarser resolution than the target — see `CELL_ESTIMATE_BUDGET`.
	 */
	coarsenedFeatures: number
	/**
	 * The resolutions actually present, finest last.
	 */
	resolutions: number[]
	perZone: Array<{ zoneCode: string; wholeCells: number; compactedWholeCells: number; partialCells: number }>
}

/**
 * Accumulate one resolution's cell index over a stream of features.
 *
 * Held as short-cell STRINGS rather than the integers the tables store, because `compactCells` and `cellToParent` are
 * h3-js functions over full indexes and round-tripping through the integer form at every step would cost more than the
 * strings do.
 */
export class FloodCellIndex {
	readonly resolution: number

	readonly #zones = new Map<string, ZoneAccumulator>()
	/**
	 * `partial cell → area ids`. Populated for every touched cell and pruned at {@link FloodCellIndex.finish} once the
	 * whole-cell sets are known — a cell that turns out whole for its zone needs no candidate list, and which cells those
	 * are is not decided until every feature has been seen.
	 */
	readonly #candidates = new Map<string, Set<string>>()

	#coarsened = 0

	constructor(resolution: number) {
		this.resolution = resolution
	}

	/**
	 * Fold one feature's classification in.
	 */
	add(zoneCode: string, areaID: string, cells: FeatureCells): void {
		if (cells.resolution !== this.resolution) {
			this.#coarsened++
		}

		let zone = this.#zones.get(zoneCode)

		if (!zone) {
			zone = { whole: new Set(), touched: new Set() }

			this.#zones.set(zoneCode, zone)
		}

		for (const cell of cells.whole) {
			zone.whole.add(cell)
			zone.touched.add(cell)
		}

		for (const cell of cells.partial) {
			zone.touched.add(cell)

			let areas = this.#candidates.get(cell)

			if (!areas) {
				areas = new Set()

				this.#candidates.set(cell, areas)
			}

			areas.add(areaID)
		}
	}

	/**
	 * Compact the whole-cell sets, prune the candidate lists, and report the rows plus the measurement.
	 *
	 * Compaction is where the size contract is paid: a zone's uniform interior collapses parent-ward into a handful of
	 * coarse cells and only the fringe stays fine, which is hierarchy-respecting run-length encoding. It is applied to
	 * the WHOLE set only — a partial cell's parent is not partial in any useful sense, and compacting it would claim the
	 * fringe covers ground it does not.
	 */
	finish(): {
		zoneCells: Array<{ h3Cell: number; resolution: number; zoneCode: string; containment: "whole" | "partial" }>
		candidates: Array<{ h3Cell: number; resolution: number; areaID: string }>
		measurement: CellIndexMeasurement
	} {
		const zoneCells: Array<{
			h3Cell: number
			resolution: number
			zoneCode: string
			containment: "whole" | "partial"
		}> = []

		const partialCellKeys = new Set<string>()
		const perZone: CellIndexMeasurement["perZone"] = []
		const resolutions = new Set<number>()

		let touchedTotal = 0
		let wholeTotal = 0
		let partialTotal = 0
		let compactedTotal = 0

		for (const [zoneCode, zone] of [...this.#zones].toSorted(([left], [right]) => (left < right ? -1 : 1))) {
			// `compactCells` takes one resolution at a time, and a coarsened feature's cells are at another — so the whole
			// set is grouped before compaction rather than pooled. Pooling would throw; compacting the target-resolution
			// group alone would silently drop every coarsened feature's interior.
			const compacted: string[] = []

			for (const group of groupCellsByResolution(zone.whole)) {
				compacted.push(...compactCells(group))
			}

			for (const cell of compacted) {
				const resolution = getResolution(cell)

				resolutions.add(resolution)

				zoneCells.push({
					h3Cell: shortCellToInt(cell as H3Cell),
					resolution,
					zoneCode,
					containment: "whole",
				})
			}

			let partialForZone = 0

			for (const cell of zone.touched) {
				if (zone.whole.has(cell)) continue

				const resolution = getResolution(cell)

				resolutions.add(resolution)
				partialCellKeys.add(cell)

				partialForZone++

				zoneCells.push({
					h3Cell: shortCellToInt(cell as H3Cell),
					resolution,
					zoneCode,
					containment: "partial",
				})
			}

			touchedTotal += zone.touched.size
			wholeTotal += zone.whole.size
			partialTotal += partialForZone
			compactedTotal += compacted.length

			perZone.push({
				zoneCode,
				wholeCells: zone.whole.size,
				compactedWholeCells: compacted.length,
				partialCells: partialForZone,
			})
		}

		const candidates: Array<{ h3Cell: number; resolution: number; areaID: string }> = []

		for (const [cell, areas] of this.#candidates) {
			// A cell that is partial for NO zone was covered wholly by every zone that reached it, so its candidate list
			// would never be read.
			if (!partialCellKeys.has(cell)) continue

			const h3Cell = shortCellToInt(cell as H3Cell)
			const resolution = getResolution(cell)

			for (const areaID of areas) {
				candidates.push({ h3Cell, resolution, areaID })
			}
		}

		return {
			zoneCells,
			candidates,
			measurement: {
				resolution: this.resolution,
				touchedCells: touchedTotal,
				wholeCells: wholeTotal,
				partialCells: partialTotal,
				partialShare: touchedTotal ? partialTotal / touchedTotal : 0,
				compactedWholeCells: compactedTotal,
				candidatePairs: candidates.length,
				coarsenedFeatures: this.#coarsened,
				resolutions: [...resolutions].toSorted((left, right) => left - right),
				perZone,
			},
		}
	}
}
