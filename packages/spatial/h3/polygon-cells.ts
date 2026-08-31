/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Turn one authority polygon into the H3 cells that summarize it — the conversion SCOPE invariant 6 asks
 *   for, done once at build time so the runtime probes structure instead of geometry.
 *
 *   SHARED BY EVERY POLYGON LAYER RATHER THAN COPIED INTO EACH, because the traps below are properties of
 *   the TOOL rather than of any one product. `packages/flood` measured them; `packages/soil` inherits them
 *   unchanged; the layer contract's polygon-builder section states them as requirements. A second copy of
 *   an allocator guard is a second place for it to stop guarding.
 *
 *   THE INDEX IS CELL-TOUCHES-POLYGON, NOT CENTRE-IN-POLYGON, AND A ZERO-CELL FEATURE FAILS THE BUILD.
 *   A polyfill keyed on cell centres drops every polygon smaller than a cell, and each dropped feature
 *   reads downstream as an absence. Measured: on Ireland's zoning layer `polygonToCells` returns zero cells
 *   for 86.8% of polygons at resolution 9, and the EA flood product's first row is a 128 m² square that
 *   `polygonToCells` misses at resolutions 7 through 10 while `containmentOverlapping` returns one cell for
 *   it. So the index takes overlapping containment, and {@link classifyFeatureCells} throws on a feature
 *   that reaches no cell rather than skipping it.
 *
 *   THE `[lat, lng]` TRAP IS AVOIDED BY NOT ENTERING IT. h3-js reads a vertex as `[lat, lng]` in its
 *   default mode; every call here passes `isGeoJSON = true` and hands it GeoJSON-order `[lon, lat]` rings,
 *   which is the order an ingest already produces. Converting instead would put a transposition between the
 *   geometry and the index that nothing downstream could see.
 *
 *   WHOLE AND PARTIAL ARE TWO POLYFILLS OF THE SAME RING, NOT A TEST WE INVENT. `containmentFull` is the
 *   cell set entirely inside the polygon; `containmentOverlapping` is the set that touches it at all. The
 *   difference is exactly the boundary fringe, which is where the geometry tier has to be consulted.
 *
 *   MOST PARTS NEVER REACH h3 AT ALL, AND THAT IS THE POINT. The WASM heap is exhausted by CALL VOLUME, not
 *   by any one polygon: h3-js frees every buffer it allocates, so what accumulates over millions of
 *   interleaved tiny and large allocations is fragmentation. Three runs over the EA product died on the
 *   same feature after roughly 510,000 others — a 164 m² feature of 23 parts and 130 vertices that
 *   classifies in 35 ms at every resolution 9 through 4 in a fresh process. So the calls are removed rather
 *   than shrunk, in the two places where the answer is a fact about geometry: {@link enclosingCell} (a part
 *   whose bounding-box corners all fall in one cell lies inside it, because a cell is convex) and
 *   {@link canContainCell} (a part narrower than `edge × √3` cannot enclose a hexagon, so its
 *   `containmentFull` set is empty). Both were checked against the unconditional polyfill over 60,000 real
 *   features at resolution 9 with zero disagreements, and `packages/flood/test/unit/cells.test.ts` pins the
 *   comparison.
 *
 *   A BIG POLYGON IS ALSO INDEXED COARSER, BECAUSE h3's ALLOCATOR IS SIZED FROM THE BOUNDING BOX.
 *   `polygonToCells` reserves room for the whole bounding box before it walks anything, so a long thin river
 *   polygon reserves the rectangle the river's meanders span rather than the river. Each feature is
 *   therefore indexed at the finest resolution whose bounding-box estimate fits {@link CELL_ESTIMATE_BUDGET},
 *   and the resolution it got is returned on the result. That is not a compromise bolted on: a coarse cell
 *   wholly inside a large polygon is exactly what `compactCells` would have produced anyway, so the whole
 *   tier is unchanged in meaning and only the fringe is coarser.
 *
 *   AND THE ESTIMATE IS A PREDICTION, SO AN ALLOCATION FAILURE IS RECOVERED RATHER THAN FATAL.
 *   {@linkcode classifyFeatureCells} steps the resolution down and retries; only a feature that fails at
 *   {@linkcode MIN_INDEX_RESOLUTION} is refused. Nothing is ever skipped, because a skipped feature is an
 *   invented absence.
 *
 *   BOUNDING THE CALL VOLUME IS THE CALLER'S JOB AND IT IS NOT OPTIONAL. The shortcuts here make a build
 *   faster; they are not what makes it reproducible. A builder runs the classification in child processes
 *   over ranges of the source's own stable ids, so each gets a heap that starts empty — see
 *   `packages/flood/sdk/ingest-chunk.ts` and `packages/soil/sdk/ingest-chunk.ts`.
 */

import {
	cellToChildren,
	cellToParent,
	compactCells,
	getHexagonAreaAvg,
	getHexagonEdgeLengthAvg,
	getResolution,
	latLngToCell,
	polygonToCellsExperimental,
	POLYGON_TO_CELLS_FLAGS,
} from "h3-js"

import type { MultiPolygonRings } from "#geometries/polygon"
import { ringsBoundingBox } from "#geometries/ring-blob"
import { shortCellToInt, type H3Cell } from "#h3/cell"

/**
 * The largest bounding-box cell estimate a single polyfill may reserve.
 *
 * H3-js allocates its output buffer from the polygon's bounding box before walking, so this is a memory ceiling rather
 * than a limit on real output: two million cells is sixteen megabytes of `uint64`, comfortably inside the WASM heap,
 * and the largest EA flood features exceed it by orders of magnitude at resolution 9 (the run that established this
 * failed with `Memory allocation failed (code: 13)`).
 */
export const CELL_ESTIMATE_BUDGET = 2_000_000

/**
 * The coarsest resolution a feature may be pushed down to. Below this a "cell" is tens of thousands of square
 * kilometres and the index stops summarizing anything.
 */
export const MIN_INDEX_RESOLUTION = 4

/**
 * Metres per degree of latitude — the constant the bounding-box estimates below are built on.
 */
const METRES_PER_DEGREE = 111_320

/**
 * A rectangle in degrees, the shape every helper here prefilters on.
 */
export interface DegreeBox {
	minLat: number
	minLon: number
	maxLat: number
	maxLon: number
}

/**
 * The single cell containing this whole bounding box, or `undefined` when it spans more than one.
 *
 * An H3 cell is convex, so a rectangle whose four corners all fall in the same cell lies entirely inside it. That makes
 * this an exact answer rather than an approximation, and it takes the WASM polyfill off the majority of a small-polygon
 * product's parts: 38.8% of the EA flood features are under 11 m across, and most parts of the multi-part ones are
 * smaller still.
 */
function enclosingCell(box: DegreeBox, resolution: number): string | undefined {
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
function canContainCell(box: DegreeBox, resolution: number): boolean {
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
 * How many cells at `resolution` the feature's bounding box spans.
 *
 * The same quantity h3 reserves its buffer from, computed here so an oversized polyfill is never issued. Approximate on
 * purpose: it decides which resolution to ask for, not what the answer is.
 */
export function estimateCellCount(polygons: MultiPolygonRings, resolution: number): number {
	const box = ringsBoundingBox(polygons)

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
 * @param layerLabel Names the layer in every message, so a build log says which artifact refused rather than only which
 *   feature.
 * @throws {Error} When the feature reaches no cell at all. That cannot happen with overlapping containment on a valid
 *   ring, so it means the geometry is degenerate — and a silently skipped feature is an invented absence.
 */
export function classifyFeatureCells(
	polygons: MultiPolygonRings,
	targetResolution: number,
	featureID: string,
	layerLabel = "polygon index"
): FeatureCells {
	let resolution = resolutionForFeature(polygons, targetResolution)
	let touched = new Set<string>()
	let full = new Set<string>()

	// THE BUDGET IS A PREDICTION AND THE RETRY IS WHAT MAKES IT NON-FATAL. `estimateCellCount` is a bounding-box
	// approximation of what h3 will reserve, and h3's own reservation depends on the polygon's shape and on what the WASM
	// heap already holds — measured over the EA product, a run that had classified 350,000 features threw `Memory
	// allocation failed (code: 13)` on a feature that classified cleanly on its own. So an allocation failure steps the
	// resolution down and tries again rather than ending the build, and only a feature that fails at
	// {@link MIN_INDEX_RESOLUTION} is refused: a coarser cell is a real answer, and a skipped feature is an invented
	// absence.
	for (;;) {
		try {
			touched = new Set<string>()
			full = new Set<string>()

			for (const rings of polygons) {
				// `isGeoJSON = true`: the rings are already `[lon, lat]`, which is the order an ingest emits. Converting
				// instead would put a transposition between the geometry and the index that nothing downstream could see.
				const geoJSONRings = rings as number[][][]
				const box = ringsBoundingBox([rings])
				const enclosing = enclosingCell(box, resolution)

				// A PART THAT FITS INSIDE ONE CELL IS ANSWERED WITHOUT THE ALLOCATOR, and that is a fact rather than an
				// approximation: an H3 cell is convex, so a rectangle whose four corners all fall in one cell lies entirely
				// within it. Such a part touches exactly that cell and fills none of it.
				if (enclosing) {
					touched.add(enclosing)

					continue
				}

				const overlapping = polygonToCellsExperimental(
					geoJSONRings,
					resolution,
					POLYGON_TO_CELLS_FLAGS.containmentOverlapping,
					true
				)

				// AN EMPTY ANSWER FOR A REAL PART IS AN ALLOCATOR FAILURE WEARING A RESULT'S CLOTHES, and it has to be caught
				// HERE rather than after the whole feature. h3-js sizes its output buffer with `_calloc`, and a `_calloc`
				// that fails returns the null pointer — which in WASM is ordinary writable memory, so the call reports
				// success and the reader hands back an array of zeros, i.e. nothing. Every part with a non-degenerate
				// bounding box touches at least one cell, so zero is impossible as an answer. Checking per FEATURE instead
				// would pass any multi-part feature whose other parts happened to answer, and silently index it short.
				if (!overlapping.length) {
					throw new Error(
						`${layerLabel}: part of feature ${featureID} spanning ${box.minLat},${box.minLon} to ${box.maxLat},${box.maxLon} returned no cell at resolution ${resolution} — a part always touches at least one, so this is an allocator failure reported as an answer`
					)
				}

				for (const cell of overlapping) {
					touched.add(cell)
				}

				// A part narrower than a cell's minimum width cannot contain one, so its `full` set is empty and asking for it
				// is pure cost. Erring towards asking is safe — a missed whole cell becomes a partial one and the ray cast
				// still answers correctly — so the comparison is the permissive one.
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
					`${layerLabel}: feature ${featureID} could not be indexed at any resolution down to ${MIN_INDEX_RESOLUTION} — ${String(
						(error as Error).message
					)}`
				)
			}

			resolution--
		}
	}

	if (!touched.size) {
		throw new Error(
			`${layerLabel}: feature ${featureID} reaches no cell at resolution ${resolution} — a feature indexed to nothing reads downstream as an absence, which is the one answer a layer must never invent`
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
 * Split a cell set into same-resolution groups — what `compactCells` requires, and what an adaptively-indexed layer
 * cannot assume it already has.
 *
 * Pooling mixed resolutions throws inside h3; compacting only the target-resolution group would silently drop every
 * coarsened feature's interior, which is the shape of failure that still produces an artifact.
 */
export function groupCellsByResolution(cells: Iterable<string>): string[][] {
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
 * One classified feature's cell rows, ready for insertion — the whole set compacted, the partial set left at its own
 * resolution.
 *
 * SHARED BY EVERY POLYGON LAYER WHOSE CELL ROW NAMES A POLYGON rather than a class accumulated across features. There
 * is no product knowledge in it: compaction, the short-cell encoding and the belt-and-braces subtraction below are h3
 * and blob arithmetic, and a second copy is a second place for the subtraction to stop happening.
 *
 * COMPACTION IS PER FEATURE, which is what keeps a build's memory flat in row count with no temporary table: a row that
 * names one polygon is final the moment that polygon is classified. Only the WHOLE set is compacted — compacting the
 * fringe would claim it covers ground it does not.
 */
export function featureCellRows(cells: FeatureCells): Array<{
	h3Cell: number
	resolution: number
	containment: "whole" | "partial"
}> {
	const rows: Array<{ h3Cell: number; resolution: number; containment: "whole" | "partial" }> = []
	const wholeShort = new Set<number>()

	for (const group of groupCellsByResolution(cells.whole)) {
		for (const cell of compactCells(group)) {
			const resolution = getResolution(cell)
			const short = shortCellToInt(cell as H3Cell)

			wholeShort.add(short)
			rows.push({ h3Cell: short, resolution, containment: "whole" })
		}
	}

	for (const cell of cells.partial) {
		const short = shortCellToInt(cell)

		// A cell cannot be both for one polygon; the classifier already subtracts the whole set, and this is belt and braces
		// against a compaction that produced a parent the partial set also names.
		if (wholeShort.has(short)) continue

		rows.push({ h3Cell: short, resolution: cells.resolution, containment: "partial" })
	}

	return rows
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

/**
 * Record the coverage cells one index cell falls in.
 *
 * An adaptively-coarsened cell can be COARSER than the coverage resolution, in which case it spans several coverage
 * cells and every one of them is recorded: a coarse cell counted against one arbitrary child would leave the others
 * reading as empty.
 */
export function addCoverageCells(
	into: Set<number>,
	cell: H3Cell,
	cellResolution: number,
	coverageResolution: number
): void {
	if (cellResolution === coverageResolution) {
		into.add(shortCellToInt(cell))

		return
	}

	if (cellResolution > coverageResolution) {
		into.add(shortCellToInt(coverageCellFor(cell, coverageResolution)))

		return
	}

	for (const child of cellToChildren(cell, coverageResolution)) {
		into.add(shortCellToInt(child as H3Cell))
	}
}
