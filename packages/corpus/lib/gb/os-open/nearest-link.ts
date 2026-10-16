/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The nearest line feature to each of a set of points, measured point-to-segment in a planar
 *   projection.
 *
 *   The points sit in a bucket grid and the lines stream past it. Each segment of each line asks the
 *   grid for the points inside its bounding box widened by the search radius, and each of those
 *   points keeps the nearest line it has been offered. Memory is bounded by the point count rather
 *   than by the line count, so a whole country's road network can be read once from disk.
 *
 *   Distances are Euclidean in the projection's own units. For EPSG:27700, the British National
 *   Grid, those are meters, and the grid's scale error stays under 0.04% across Great Britain.
 */

import { planarSegmentDistanceSquared } from "@mailwoman/spatial/distance"

/**
 * The multiplier that packs a cell's column and row into one numeric key.
 *
 * A row index must stay below it.
 * With 100 m cells, 2^21 rows span 209,715 km, so a projected coordinate in meters cannot reach it.
 */
const CELL_ROW_SPAN = 2 ** 21

/**
 * A uniform grid of point indices, keyed by cell.
 */
export class PointBucketIndex {
	readonly cellSize: number

	readonly #cells = new Map<number, number[]>()

	constructor(cellSize: number) {
		if (!(cellSize > 0)) throw new RangeError(`PointBucketIndex: cell size must be positive, got ${cellSize}`)

		this.cellSize = cellSize
	}

	#key(column: number, row: number): number {
		return column * CELL_ROW_SPAN + row
	}

	/**
	 * Files the point `index` under the cell holding `(x, y)`.
	 */
	add(index: number, x: number, y: number): void {
		const key = this.#key(Math.floor(x / this.cellSize), Math.floor(y / this.cellSize))
		const bucket = this.#cells.get(key)

		if (bucket) {
			bucket.push(index)
		} else {
			this.#cells.set(key, [index])
		}
	}

	/**
	 * Every point index filed in a cell that the box touches.
	 *
	 * The answer holds every point of each touched cell, including points up to one cell outside the box.
	 * A caller measures each one.
	 */
	*within(minX: number, minY: number, maxX: number, maxY: number): Generator<number> {
		const firstColumn = Math.floor(minX / this.cellSize)
		const lastColumn = Math.floor(maxX / this.cellSize)
		const firstRow = Math.floor(minY / this.cellSize)
		const lastRow = Math.floor(maxY / this.cellSize)

		for (let column = firstColumn; column <= lastColumn; column++) {
			for (let row = firstRow; row <= lastRow; row++) {
				const bucket = this.#cells.get(this.#key(column, row))

				if (bucket) {
					yield* bucket
				}
			}
		}
	}
}

/**
 * The line a point was joined to, and how far away it lies.
 */
export interface NearestLinkMatch<T> {
	link: T
	/**
	 * The point-to-segment distance in projection units.
	 */
	distance: number
}

/**
 * Joins each point to the nearest line offered to it within `radius`.
 *
 * A line offered at exactly the same distance as the current nearest does not replace it,
 * so the first-offered line wins a tie and the answer follows the order the lines are read in.
 */
export class NearestLinkJoin<T> {
	readonly radius: number

	readonly #xs: Float64Array
	readonly #ys: Float64Array
	readonly #bestSquared: Float64Array
	readonly #best: (T | undefined)[]
	readonly #index: PointBucketIndex

	/**
	 * @param points The points to join, as parallel coordinate arrays.
	 * A point's position in the arrays is its index in every answer.
	 * @param radius The largest distance at which a line joins, in projection units.
	 */
	constructor(points: { xs: Float64Array; ys: Float64Array }, radius: number) {
		if (points.xs.length !== points.ys.length) {
			throw new RangeError(`NearestLinkJoin: ${points.xs.length} x values against ${points.ys.length} y values`)
		}

		this.radius = radius
		this.#xs = points.xs
		this.#ys = points.ys
		this.#bestSquared = new Float64Array(points.xs.length).fill(Number.POSITIVE_INFINITY)
		this.#best = Array.from({ length: points.xs.length })
		this.#index = new PointBucketIndex(radius)

		for (let i = 0; i < points.xs.length; i++) {
			this.#index.add(i, points.xs[i]!, points.ys[i]!)
		}
	}

	/**
	 * Offers one line, as a flat `[x0, y0, x1, y1, …]` vertex array, to every point within reach of it.
	 */
	offer(link: T, vertices: ArrayLike<number>): void {
		const radius = this.radius
		const radiusSquared = radius * radius

		for (let v = 0; v + 3 < vertices.length; v += 2) {
			const ax = vertices[v]!
			const ay = vertices[v + 1]!
			const bx = vertices[v + 2]!
			const by = vertices[v + 3]!

			for (const i of this.#index.within(
				Math.min(ax, bx) - radius,
				Math.min(ay, by) - radius,
				Math.max(ax, bx) + radius,
				Math.max(ay, by) + radius
			)) {
				const squared = planarSegmentDistanceSquared(this.#xs[i]!, this.#ys[i]!, ax, ay, bx, by)

				if (squared <= radiusSquared && squared < this.#bestSquared[i]!) {
					this.#bestSquared[i] = squared
					this.#best[i] = link
				}
			}
		}
	}

	/**
	 * The nearest line offered to point `index`, or null when none came within the radius.
	 */
	match(index: number): NearestLinkMatch<T> | null {
		const link = this.#best[index]

		return link === undefined ? null : { link, distance: Math.sqrt(this.#bestSquared[index]!) }
	}
}
