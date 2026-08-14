/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { cellToLatLng } from "h3-js"

import { GeoPoint, type PointLiteral } from "../geometries/point.ts"
import { type H3Cell, type H3CellShort, expandH3Cell } from "./cell.ts"

export * from "./cell.ts"

/**
 * Given a short cell address and the resolution it was captured at, return the centre of that cell.
 */
export function shortCellToPoint(shortCell: H3CellShort, resolution = 15): GeoPoint {
	const cell = expandH3Cell(shortCell, resolution)

	// Convert the H3 cell index back to latitude and longitude
	const [latitude, longitude] = cellToLatLng(cell)

	return new GeoPoint([longitude, latitude])
}

export function cellToPointLiteral(cell: H3Cell): PointLiteral {
	const [latitude, longitude] = cellToLatLng(cell)

	return {
		type: "Point",
		coordinates: [longitude, latitude],
	}
}
