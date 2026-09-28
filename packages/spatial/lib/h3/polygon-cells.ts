/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Turn one authority polygon into the H3 cells that summarize it, done once at build time so the
 *   runtime probes structure instead of geometry.
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

import type { LatLonBounds } from "#bbox"
import { METRES_PER_DEGREE } from "#distance"
import type { MultiPolygonRings } from "#geometries/polygon"
import { ringsBoundingBox } from "#geometries/ring-blob"
import { shortCellToInt, type H3Cell } from "#h3/cell"

/**
 * The largest bounding-box cell estimate a single polyfill may reserve, a memory ceiling
 * because h3-js allocates its output buffer from the polygon's bounding box before walking.
 */
export const CELL_ESTIMATE_BUDGET = 2_000_000

/**
 * The coarsest resolution a feature may be pushed down to, below which a cell is tens
 * of thousands of square kilometres and the index stops summarizing anything.
 */
export const MIN_INDEX_RESOLUTION = 4

/**
 * A degree box's height and width in metres, longitude scaled at the box's
 * mid-latitude so the two are comparable.
 */
function boxExtentMetres(box: LatLonBounds): { heightM: number; widthM: number } {
	const midLat = ((box.minLat + box.maxLat) / 2) * (Math.PI / 180)

	return {
		heightM: (box.maxLat - box.minLat) * METRES_PER_DEGREE,
		widthM: (box.maxLon - box.minLon) * METRES_PER_DEGREE * Math.cos(midLat),
	}
}

/**
 * The single cell containing this whole bounding box, or `undefined` when it spans
 * more than one — exact because an H3 cell is convex.
 */
function enclosingCell(box: LatLonBounds, resolution: number): string | undefined {
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
 * Could a shape this size contain a whole cell — false when either bounding-box dimension is
 * under `edge × √3`, compared permissively because a wrong `true` only costs one polyfill call.
 */
function canContainCell(box: LatLonBounds, resolution: number): boolean {
	if (!Number.isFinite(box.minLat)) return false

	const minimumWidthM = getHexagonEdgeLengthAvg(resolution, "m") * Math.sqrt(3)
	const { heightM, widthM } = boxExtentMetres(box)

	return heightM >= minimumWidthM && widthM >= minimumWidthM
}

/**
 * The two cell sets one feature produces, and the resolution they came out at.
 */
export interface FeatureCells {
	/**
	 * The resolution this feature was indexed at — the target, or coarser
	 * where the target's estimate did not fit.
	 */
	resolution: number
	/**
	 * Cells lying entirely inside the feature, so a point in one is inside without a geometry read.
	 */
	whole: H3Cell[]
	/**
	 * Cells the feature reaches but does not fill, so a point in one needs the ray cast.
	 */
	partial: H3Cell[]
}

/**
 * How many cells at `resolution` the feature's bounding box spans — the same quantity
 * h3 reserves its buffer from, approximate on purpose.
 */
export function estimateCellCount(polygons: MultiPolygonRings, resolution: number): number {
	const box = ringsBoundingBox(polygons)

	if (!Number.isFinite(box.minLat)) return 0

	const { heightM, widthM } = boxExtentMetres(box)
	const heightKM = heightM / 1000
	const widthKM = widthM / 1000

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
 * Classify one feature's cells at `targetResolution` or the coarsest resolution its
 * bounding box allows, throwing when the feature reaches no cell at all.
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

	// `estimateCellCount` approximates what h3 will reserve, so an allocation
	// failure steps the resolution down and retries rather than ending the build;
	// a feature that fails at {@link MIN_INDEX_RESOLUTION} is refused.
	for (;;) {
		try {
			touched = new Set<string>()
			full = new Set<string>()

			for (const rings of polygons) {
				// `isGeoJSON = true`: the rings are already `[lon, lat]`, so converting would
				// put a transposition between the geometry and the index.
				const geoJSONRings = rings as number[][][]
				const box = ringsBoundingBox([rings])
				const enclosing = enclosingCell(box, resolution)

				// A part that fits inside one cell is answered without the allocator: an H3 cell
				// is convex, so a rectangle whose corners share a cell lies entirely within it.
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

				// An empty answer for a real part is an allocator failure, not a result: every part with
				// a non-degenerate bounding box touches at least one cell, so zero is impossible as
				// an answer and checking per feature would silently index a multi-part feature short.
				if (!overlapping.length) {
					throw new Error(
						`${layerLabel}: part of feature ${featureID} spanning ${box.minLat},${box.minLon} to ${box.maxLat},${box.maxLon} returned no cell at resolution ${resolution} — a part always touches at least one, so this is an allocator failure reported as an answer`
					)
				}

				for (const cell of overlapping) {
					touched.add(cell)
				}

				// A part narrower than a cell's minimum width cannot contain one, so its `full`
				// set is empty and asking for it is pure cost; the comparison is permissive
				// because a missed whole cell becomes a partial one the ray cast still answers.
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
					`${layerLabel}: feature ${featureID} could not be indexed at any resolution down to ${MIN_INDEX_RESOLUTION}`,
					{ cause: error }
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

	// A cell can be full for one polygon of a MultiPolygon and merely touched by another;
	// full wins because the point is inside either way.
	const partial: H3Cell[] = []

	for (const cell of touched) {
		if (!full.has(cell)) {
			partial.push(cell as H3Cell)
		}
	}

	return { resolution, whole: [...full] as H3Cell[], partial }
}

/**
 * Split a cell set into same-resolution groups — what `compactCells` requires
 * and an adaptively-indexed layer cannot assume it already has.
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
 * Compact a cell set that may span several resolutions by grouping it before compaction
 * rather than pooling, which would throw inside h3.
 */
export function compactAcrossResolutions(cells: Iterable<string>): string[] {
	const compacted: string[] = []

	for (const group of groupCellsByResolution(cells)) {
		compacted.push(...compactCells(group))
	}

	return compacted
}

/**
 * The cells a probe walks for one index cell: the cell itself at the index resolution,
 * and its parent at every other resolution the layer stores.
 */
export function ancestorChainCells(
	indexCell: H3Cell,
	indexResolution: number,
	resolutions: readonly number[]
): H3Cell[] {
	return resolutions.map((resolution) =>
		resolution === indexResolution ? indexCell : (cellToParent(indexCell, resolution) as H3Cell)
	)
}

/**
 * One classified feature's cell rows, ready for insertion — the whole set compacted,
 * the partial set left at its own resolution.
 */
export function featureCellRows(cells: FeatureCells): Array<{
	h3Cell: number
	resolution: number
	containment: "whole" | "partial"
}> {
	const rows: Array<{ h3Cell: number; resolution: number; containment: "whole" | "partial" }> = []
	const wholeShort = new Set<number>()

	for (const cell of compactAcrossResolutions(cells.whole)) {
		const resolution = getResolution(cell)
		const short = shortCellToInt(cell as H3Cell)

		wholeShort.add(short)
		rows.push({ h3Cell: short, resolution, containment: "whole" })
	}

	for (const cell of cells.partial) {
		const short = shortCellToInt(cell)

		// A cell cannot be both for one polygon; this subtraction is belt and braces against
		// a compaction that produced a parent the partial set also names.
		if (wholeShort.has(short)) continue

		rows.push({ h3Cell: short, resolution: cells.resolution, containment: "partial" })
	}

	return rows
}

/**
 * The coverage cell a row at `cell` belongs to, derived with `cellToParent` rather than a
 * fresh `latLngToCell` so a fringe row does not land in a neighbouring coverage cell.
 */
export function coverageCellFor(cell: H3Cell, coverageResolution: number): H3Cell {
	return cellToParent(cell, coverageResolution) as H3Cell
}

/**
 * Record the coverage cells one index cell falls in, so an adaptively-coarsened cell coarser
 * than the coverage resolution counts against every child rather than one arbitrary child.
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
