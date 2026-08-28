/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Turn one authority polygon into the H3 cells that summarize it — the conversion SCOPE invariant 6
 *   asks for, done once at build time so the runtime probes structure instead of geometry.
 *
 *   THE INDEX IS CELL-TOUCHES-POLYGON, NOT CENTRE-IN-POLYGON, AND A ZERO-CELL FEATURE FAILS THE BUILD.
 *   A polyfill keyed on cell centres drops every polygon smaller than a cell, and each dropped feature
 *   reads downstream as an absence — indistinguishable from the designated Zone 1 absence this layer is
 *   built to report. The EA product is full of such features: its first row is a 128 m² square, and
 *   `polygonToCells` returns ZERO cells for it at resolutions 7, 8, 9 and 10 alike, while
 *   `containmentOverlapping` returns one. So the index takes overlapping containment, and
 *   {@link classifyFeatureCells} throws on a feature that reaches no cell rather than skipping it.
 *
 *   THE `[lat, lng]` TRAP IS AVOIDED BY NOT ENTERING IT. h3-js reads a vertex as `[lat, lng]` in its
 *   default mode; every call here passes `isGeoJSON = true` and hands it GeoJSON-order `[lon, lat]`
 *   rings, which is the order the ingest already produces. Converting instead would put a transposition
 *   between the geometry and the index that nothing downstream could see.
 *
 *   WHOLE AND PARTIAL ARE TWO POLYFILLS OF THE SAME RING, NOT A TEST WE INVENT. `containmentFull` is the
 *   cell set entirely inside the polygon; `containmentOverlapping` is the set that touches it at all. The
 *   difference is exactly the boundary fringe, which is where the geometry tier has to be consulted.
 *
 *   A BIG POLYGON IS INDEXED COARSER, BECAUSE h3's ALLOCATOR IS SIZED FROM THE BOUNDING BOX. `polygonToCells`
 *   reserves room for the whole bounding box before it walks anything, so a long thin river polygon — a
 *   shape this product is full of — reserves the rectangle the river's meanders span rather than the river.
 *   Asking for resolution 9 over the largest of them threw `Memory allocation failed (code: 13)` out of the
 *   WASM heap after 350,000 features. So each feature is indexed at the finest resolution whose bounding-box
 *   estimate fits {@link CELL_ESTIMATE_BUDGET}, and the resolution it got is stored on the row. That is not
 *   a compromise bolted on: a coarse cell wholly inside a large polygon is exactly what `compactCells` would
 *   have produced anyway, so the whole tier is unchanged in meaning and only the fringe is coarser.
 *
 *   AND THE ESTIMATE IS A PREDICTION, SO THE FAILURE IS RECOVERED RATHER THAN FATAL. The same feature that
 *   threw after 350,000 others classified cleanly when run on its own, which says the ceiling depends on
 *   what the WASM heap already holds and not only on the polygon. {@linkcode classifyFeatureCells} therefore
 *   steps the resolution down and retries; only a feature that fails at {@linkcode MIN_INDEX_RESOLUTION} is
 *   refused. Nothing is ever skipped, because a skipped feature is an invented absence.
 */

import { shortCellToInt, type H3Cell } from "@mailwoman/spatial"
import {
	cellToParent,
	compactCells,
	getHexagonAreaAvg,
	getHexagonEdgeLengthAvg,
	getResolution,
	latLngToCell,
	polygonToCellsExperimental,
	POLYGON_TO_CELLS_FLAGS,
} from "h3-js"

import type { MultiPolygonRings } from "./ingest.ts"

/**
 * The largest bounding-box cell estimate a single polyfill may reserve.
 *
 * H3-js allocates its output buffer from the polygon's bounding box before walking, so this is a memory ceiling rather
 * than a limit on real output: two million cells is sixteen megabytes of `uint64`, comfortably inside the WASM heap,
 * and the largest EA features exceed it by orders of magnitude at resolution 9 (the run that established this failed
 * with `Memory allocation failed (code: 13)`).
 */
export const CELL_ESTIMATE_BUDGET = 2_000_000

/**
 * The coarsest resolution a feature may be pushed down to. Below this a "cell" is tens of thousands of square
 * kilometres and the index stops summarizing anything.
 */
export const MIN_INDEX_RESOLUTION = 4

/**
 * The single cell containing this whole bounding box, or `undefined` when it spans more than one.
 *
 * An H3 cell is convex, so a rectangle whose four corners all fall in the same cell lies entirely inside it. That makes
 * this an exact answer rather than an approximation, and it takes the WASM polyfill off the majority of this product's
 * parts: 38.8% of its features are under 11 m across, and most parts of the multi-part ones are smaller still.
 */
function enclosingCell(
	box: { minLat: number; minLon: number; maxLat: number; maxLon: number },
	resolution: number
): string | undefined {
	if (!Number.isFinite(box.minLat)) return undefined

	const first = latLngToCell(box.minLat, box.minLon, resolution)

	for (const [lat, lon] of [
		[box.minLat, box.maxLon],
		[box.maxLat, box.minLon],
		[box.maxLat, box.maxLon],
	] as Array<[number, number]>) {
		if (latLngToCell(lat, lon, resolution) !== first) return undefined
	}

	return first
}

/**
 * Could a shape this size contain a whole cell?
 *
 * A hexagon's minimum width is twice its inradius, and its inradius is `edge × √3/2` — so a bounding box narrower than
 * `edge × √3` in either direction cannot enclose one, and the `containmentFull` polyfill is guaranteed to return
 * nothing. The comparison is deliberately permissive: a wrong `true` costs one polyfill call, while a wrong `false`
 * would demote a whole cell to a partial one, which the ray cast still answers correctly but more slowly.
 */
function canContainCell(
	box: { minLat: number; minLon: number; maxLat: number; maxLon: number },
	resolution: number
): boolean {
	if (!Number.isFinite(box.minLat)) return false

	const minimumWidthM = getHexagonEdgeLengthAvg(resolution, "m") * Math.sqrt(3)
	const midLat = ((box.minLat + box.maxLat) / 2) * (Math.PI / 180)
	const heightM = (box.maxLat - box.minLat) * METRES_PER_DEGREE
	const widthM = (box.maxLon - box.minLon) * METRES_PER_DEGREE * Math.cos(midLat)

	return heightM >= minimumWidthM && widthM >= minimumWidthM
}

/**
 * The two cell sets one feature produces, and the resolution they came out at.
 */
export interface FeatureCells {
	/**
	 * The resolution this feature was indexed at — the target, or coarser where the target's estimate did not fit.
	 */
	resolution: number
	/**
	 * Cells lying entirely inside the feature. A point in one of these is inside without a geometry read.
	 */
	whole: H3Cell[]
	/**
	 * Cells the feature reaches but does not fill. A point in one of these needs the ray cast.
	 */
	partial: H3Cell[]
}

/**
 * The bounding box of a feature's rings, in degrees.
 */
function boundingBox(polygons: MultiPolygonRings): {
	minLat: number
	minLon: number
	maxLat: number
	maxLon: number
} {
	let minLat = Infinity
	let minLon = Infinity
	let maxLat = -Infinity
	let maxLon = -Infinity

	for (const rings of polygons) {
		for (const ring of rings) {
			for (const position of ring) {
				const lon = position[0]!
				const lat = position[1]!

				if (lon < minLon) {
					minLon = lon
				}

				if (lon > maxLon) {
					maxLon = lon
				}

				if (lat < minLat) {
					minLat = lat
				}

				if (lat > maxLat) {
					maxLat = lat
				}
			}
		}
	}

	return { minLat, minLon, maxLat, maxLon }
}

/**
 * Metres per degree of latitude — the constant the bounding-box area estimate below is built on.
 */
const METRES_PER_DEGREE = 111_320

/**
 * How many cells at `resolution` the feature's bounding box spans.
 *
 * The same quantity h3 reserves its buffer from, computed here so an oversized polyfill is never issued. Approximate on
 * purpose: it decides which resolution to ask for, not what the answer is.
 */
export function estimateCellCount(polygons: MultiPolygonRings, resolution: number): number {
	const box = boundingBox(polygons)

	if (!Number.isFinite(box.minLat)) return 0

	const midLat = ((box.minLat + box.maxLat) / 2) * (Math.PI / 180)
	const heightKM = ((box.maxLat - box.minLat) * METRES_PER_DEGREE) / 1000
	const widthKM = ((box.maxLon - box.minLon) * METRES_PER_DEGREE * Math.cos(midLat)) / 1000

	return (Math.max(widthKM, 0.001) * Math.max(heightKM, 0.001)) / getHexagonAreaAvg(resolution, "km2")
}

/**
 * The finest resolution at or below `target` whose estimate fits the budget.
 */
export function resolutionForFeature(polygons: MultiPolygonRings, target: number): number {
	for (let resolution = target; resolution > MIN_INDEX_RESOLUTION; resolution--) {
		if (estimateCellCount(polygons, resolution) <= CELL_ESTIMATE_BUDGET) return resolution
	}

	return MIN_INDEX_RESOLUTION
}

/**
 * Classify one feature's cells, at `targetResolution` or the coarsest resolution its bounding box allows.
 *
 * @throws {Error} When the feature reaches no cell at all. That cannot happen with overlapping containment on a valid
 *   ring, so it means the geometry is degenerate — and a silently skipped feature is an invented absence.
 */
export function classifyFeatureCells(
	polygons: MultiPolygonRings,
	targetResolution: number,
	areaID: string
): FeatureCells {
	let resolution = resolutionForFeature(polygons, targetResolution)
	let touched = new Set<string>()
	let full = new Set<string>()

	// THE BUDGET IS A PREDICTION AND THE RETRY IS WHAT MAKES IT NON-FATAL. `estimateCellCount` is a bounding-box
	// approximation of what h3 will reserve, and h3's own reservation depends on the polygon's shape and on what the WASM
	// heap already holds — measured over the real product, a run that had classified 350,000 features threw `Memory
	// allocation failed (code: 13)` on a feature that classified cleanly on its own. So an allocation failure steps the
	// resolution down and tries again rather than ending the build, and only a feature that fails at
	// {@link MIN_INDEX_RESOLUTION} is refused: a coarser cell is a real answer, and a skipped feature is an invented
	// absence.
	for (;;) {
		try {
			touched = new Set<string>()
			full = new Set<string>()

			for (const rings of polygons) {
				// `isGeoJSON = true`: the rings are already `[lon, lat]`, which is the order the ingest emits. Converting
				// instead would put a transposition between the geometry and the index that nothing downstream could see.
				const geoJSONRings = rings as number[][][]
				const box = boundingBox([rings])
				const enclosing = enclosingCell(box, resolution)

				// A PART THAT FITS INSIDE ONE CELL IS ANSWERED WITHOUT THE ALLOCATOR, and that is a fact rather than an
				// approximation: an H3 cell is convex, so a rectangle whose four corners all fall in one cell lies entirely
				// within it. Such a part touches exactly that cell and fills none of it.
				if (enclosing) {
					touched.add(enclosing)

					continue
				}

				for (const cell of polygonToCellsExperimental(
					geoJSONRings,
					resolution,
					POLYGON_TO_CELLS_FLAGS.containmentOverlapping,
					true
				)) {
					touched.add(cell)
				}

				// Likewise: a part narrower than a cell's minimum width cannot contain one, so its `full` set is empty and
				// asking for it is pure cost. Erring towards asking is safe — a missed whole cell becomes a partial one and
				// the ray cast still answers correctly — so the comparison is the permissive one.
				if (!canContainCell(box, resolution)) continue

				for (const cell of polygonToCellsExperimental(
					geoJSONRings,
					resolution,
					POLYGON_TO_CELLS_FLAGS.containmentFull,
					true
				)) {
					full.add(cell)
				}
			}

			break
		} catch (error) {
			if (resolution <= MIN_INDEX_RESOLUTION) {
				throw new Error(
					`flood cells: feature ${areaID} could not be indexed at any resolution down to ${MIN_INDEX_RESOLUTION} — ${String(
						(error as Error).message
					)}`
				)
			}

			resolution--
		}
	}

	if (!touched.size) {
		throw new Error(
			`flood cells: feature ${areaID} reaches no cell at resolution ${resolution} — a feature indexed to nothing reads downstream as an absence, which is the one answer this layer must never invent`
		)
	}

	// A cell can be full for one polygon of a MultiPolygon and merely touched by another; full wins, because the point
	// is inside either way.
	const partial: H3Cell[] = []

	for (const cell of touched) {
		if (!full.has(cell)) {
			partial.push(cell as H3Cell)
		}
	}

	return { resolution, whole: [...full] as H3Cell[], partial }
}

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
	 * Features whose bounding box forced a coarser resolution than the target — see {@link CELL_ESTIMATE_BUDGET}.
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

			for (const group of groupByResolution(zone.whole)) {
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

/**
 * Split a cell set into same-resolution groups — what `compactCells` requires, and what an adaptively-indexed layer
 * cannot assume it already has.
 */
function groupByResolution(cells: Iterable<string>): string[][] {
	const groups = new Map<number, string[]>()

	for (const cell of cells) {
		const resolution = getResolution(cell)
		const group = groups.get(resolution)

		if (group) {
			group.push(cell)
		} else {
			groups.set(resolution, [cell])
		}
	}

	return [...groups.values()]
}

/**
 * The coverage cell a row at `cell` belongs to.
 *
 * `cellToParent` of the finer cell, never a fresh `latLngToCell` at the coarse resolution: every existing reader in
 * this repo derives a coverage cell that way, and the two agree for a point but not for a cell — a re-derivation from a
 * representative point would put a fringe row in a neighbouring coverage cell.
 */
export function coverageCellFor(cell: H3Cell, coverageResolution: number): H3Cell {
	return cellToParent(cell, coverageResolution) as H3Cell
}
