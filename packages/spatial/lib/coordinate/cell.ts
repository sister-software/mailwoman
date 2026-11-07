/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file A rectangular cell on the globe, as a plus code, a geohash or an H3 cell's box describes one.
 */

import type { LatLonBounds } from "#bbox"
import { METRES_PER_DEGREE } from "#distance"

/**
 * A cell by its center and its span in degrees, from which callers derive its box or an uncertainty radius.
 */
export interface DegreeCell {
	lat: number
	lon: number
	latSpanDeg: number
	lonSpanDeg: number
}

/**
 * The cell's bounding box.
 */
export function cellBounds(cell: DegreeCell): LatLonBounds {
	return {
		minLat: cell.lat - cell.latSpanDeg / 2,
		maxLat: cell.lat + cell.latSpanDeg / 2,
		minLon: cell.lon - cell.lonSpanDeg / 2,
		maxLon: cell.lon + cell.lonSpanDeg / 2,
	}
}

/**
 * The cell's half-diagonal in meters, never below one, so a point anywhere in
 * the cell is within it of the center.
 */
export function cellRadiusMeters(cell: DegreeCell): number {
	const latHalf = (cell.latSpanDeg / 2) * METRES_PER_DEGREE
	const lonHalf = (cell.lonSpanDeg / 2) * METRES_PER_DEGREE * Math.cos((cell.lat * Math.PI) / 180)

	return Math.max(1, Math.round(Math.hypot(latHalf, lonHalf)))
}
