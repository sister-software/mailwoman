/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Great-circle distance utilities. This module imports geometry directly so spatial's
 *   lowest-level math never reaches back through its public barrel.
 */

import { GeoPoint, type GeoPointInput } from "#geometries/point"
import { arealPolygons } from "#geometries/polygon"

/**
 * Conversion factors for converting between degrees and radians.
 *
 * @category Position
 * @see {@link https://en.wikipedia.org/wiki/Radian Wikipedia: Radian}
 * @see {@link https://en.wikipedia.org/wiki/Degree_(angle) Wikipedia: Degree (angle)}
 */
export const ConversionFactor = {
	DegreesToRadians: Math.PI / 180,
	RadiansToDegrees: 180 / Math.PI,
} as const

/**
 * Available conversion units for the radius of the Earth.
 */
export type EarthRadiusUnit = "km" | "miles" | "meters"

/**
 * Radius of the Earth in various units.
 */
const RADII = {
	km: 6371,
	miles: 3958.8,
	meters: 6_371_000,
} as const satisfies Record<EarthRadiusUnit, number>

/**
 * Shared great-circle math with no sentinel handling. `unit` selects the Earth radius.
 */
function greatCircle(lat1: number, lon1: number, lat2: number, lon2: number, unit: EarthRadiusUnit): number {
	const dLat = (lat2 - lat1) * ConversionFactor.DegreesToRadians
	const dLon = (lon2 - lon1) * ConversionFactor.DegreesToRadians

	const a =
		Math.pow(Math.sin(dLat / 2), 2) +
		Math.cos(lat1 * ConversionFactor.DegreesToRadians) *
			Math.cos(lat2 * ConversionFactor.DegreesToRadians) *
			Math.pow(Math.sin(dLon / 2), 2)

	return RADII[unit] * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

/**
 * Calculate the distance between two points on the Earth's surface.
 *
 * @category Position
 * @param point1 The first point to calculate the distance from.
 * @param point2 The second point to calculate the distance to.
 * @param unit The unit of measurement to return the distance in.
 *
 * @returns The distance between the two points in the specified unit.
 */
export function haversine(point1: GeoPointInput, point2: GeoPointInput, unit: EarthRadiusUnit = "km"): number {
	const p1 = GeoPoint.from(point1)
	const p2 = GeoPoint.from(point2)

	if (!p1 || !p2) return Number.NaN

	return greatCircle(p1.latitude, p1.longitude, p2.latitude, p2.longitude, unit)
}

/**
 * Great-circle distance in kilometres between two lat/lon pairs given as raw scalars. The formula's one true home —
 * every resolver + eval consumer of the `(aLat, aLon, bLat, bLon)` shape imports this instead of re-declaring it.
 *
 * Unlike {@link haversine}, this is pure math with NO Null-Island sentinel: `(0, 0)` is the Gulf of Guinea — a real
 * point, not "missing coordinate". That sentinel convention belongs to the `GeoPointInput` object form (where a 0/0
 * input means "no coordinate"), not to a raw scalar distance.
 *
 * @category Position
 */
export function haversineKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
	return greatCircle(aLat, aLon, bLat, bLon, "km")
}

/**
 * Metres per degree of latitude — the scale {@link segmentDistanceMetres} reports in, and the constant the bounding-box
 * estimates in `#h3/polygon-cells` are built on.
 */
export const METRES_PER_DEGREE = 111_320

/**
 * Square metres in a square kilometre — the conversion every polygon layer's area receipt reports through.
 */
export const M2_PER_KM2 = 1_000_000

/**
 * Metres from a point to a line SEGMENT, with longitude scaled for the latitude so the two axes are comparable.
 *
 * MEASURE TO THE EDGE, NOT TO THE NEAREST VERTEX. A point a centimetre from a long edge can be metres from every vertex
 * of it, so a vertex distance overstates the gap without bound — measured on the flood layer's verification, one
 * near-miss read 1.58 m to vertices and 0.009 m to edges, a 9 mm difference overstated 175-fold. That is the difference
 * between "two channels rendered the same edge slightly differently" and "the conversion is wrong".
 *
 * The longitude scaling matters at the same scale: comparing raw degrees treats a degree of longitude as a degree of
 * latitude, which at 54°N overstates east-west distance by 70%.
 *
 * @category Position
 */
export function segmentDistanceMetres(
	lon: number,
	lat: number,
	from: readonly number[],
	to: readonly number[]
): number {
	const scale = Math.cos((lat * Math.PI) / 180)
	const px = (lon - from[0]!) * scale
	const py = lat - from[1]!
	const vx = (to[0]! - from[0]!) * scale
	const vy = to[1]! - from[1]!
	const lengthSquared = vx * vx + vy * vy

	// A zero-length segment is a repeated vertex; the distance to it is the distance to the point.
	const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, (px * vx + py * vy) / lengthSquared))

	return Math.hypot(px - t * vx, py - t * vy) * METRES_PER_DEGREE
}

/**
 * Metres from a point to the nearest ring EDGE of an areal geometry — `Infinity` when the geometry bounds no area or
 * carries no segment.
 *
 * To the edge, not to the nearest vertex: a point a centimetre from a long edge can be metres from every vertex of it,
 * so a vertex distance overstates the gap without bound — measured on the flood layer's verification, one near-miss
 * read 1.58 m to vertices and 0.009 m to edges, a 9 mm difference overstated 175-fold. Every polygon layer's two-path
 * verification measures its boundary tolerance with this.
 *
 * @category Position
 */
export function nearestRingEdgeMetres(
	geometry: { type: string; coordinates: unknown },
	longitude: number,
	latitude: number
): number {
	const polygons = arealPolygons(geometry)

	let nearest = Infinity

	if (!polygons) return nearest

	for (const rings of polygons) {
		for (const ring of rings) {
			for (let index = 1; index < ring.length; index++) {
				const distance = segmentDistanceMetres(longitude, latitude, ring[index - 1]!, ring[index]!)

				if (distance < nearest) {
					nearest = distance
				}
			}
		}
	}

	return nearest
}
