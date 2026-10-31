/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Great-circle and segment distance math over plain numbers.
 *
 *   This module imports no runtime geometry class. `GeoPoint` imports h3-js. The h3-js module allocates a 32 MiB heap when
 *   it is first evaluated, and a caller that only measures a distance must not pay for that. The object-form distances
 *   that take a `GeoPointInput` live in `#geometries/point/distance`.
 */

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
 * Radius of the Earth in kilometers, miles and meters.
 */
export const EARTH_RADII = {
	km: 6371,
	miles: 3958.8,
	meters: 6_371_000,
} as const satisfies Record<EarthRadiusUnit, number>

export type PlanetaryBodyID = "earth" | "moon" | "mars"

/**
 * Mean radii in kilometers.
 *
 * Earth's is the value {@link EARTH_RADII} scales to its units.
 * The Moon's and Mars's are the IAU mean radii the usgs planetary products reference
 * (the Moon as a sphere. Mars's mean radius, its DEM being on the areoid).
 *
 * A distance on a body other than Earth is meaningless without one of these.
 */
export const BODY_RADII_KM = {
	earth: EARTH_RADII.km,
	moon: 1737.4,
	mars: 3389.5,
} as const satisfies Record<PlanetaryBodyID, number>

export interface GreatCircleOptions {
	unit?: EarthRadiusUnit
	/**
	 * Which body's mean radius scales the arc.
	 *
	 * @defaultValue `"earth"`
	 */
	body?: PlanetaryBodyID
}

/**
 * Returns the central angle in radians between two coordinates in decimal degrees, by the haversine formula.
 *
 * It applies no sentinel handling.
 * Multiply by a radius from {@link EARTH_RADII} or {@link BODY_RADII_KM} for a distance.
 *
 * @category Position
 */
export function centralAngle(lat1: number, lon1: number, lat2: number, lon2: number): number {
	const dLat = (lat2 - lat1) * ConversionFactor.DegreesToRadians
	const dLon = (lon2 - lon1) * ConversionFactor.DegreesToRadians

	const a =
		Math.pow(Math.sin(dLat / 2), 2) +
		Math.cos(lat1 * ConversionFactor.DegreesToRadians) *
			Math.cos(lat2 * ConversionFactor.DegreesToRadians) *
			Math.pow(Math.sin(dLon / 2), 2)

	return 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

/**
 * Meters per degree of latitude.
 *
 * The scale used by {@link segmentDistanceMetres}.
 * It is also the constant the bounding-box estimates in `#h3/polygon-cells` are built on.
 */
export const METRES_PER_DEGREE = 111_320

/**
 * Square meters in a square kilometer.
 *
 * The conversion every polygon layer's area receipt reports through.
 */
export const M2_PER_KM2 = 1_000_000

/**
 * Meters from a point to a line segment, with longitude scaled for the latitude
 * so the two axes are comparable.
 *
 * Measure TO the edge rather than TO the nearest vertex.
 * A point a centimeter from a long edge can be meters from every vertex of it,
 * so a vertex distance overstates the gap without bound.
 *
 * Measured on the flood layer's verification, one near-miss read 1.58 m to vertices
 * and 0.009 m to edges, a 9 mm difference overstated 175-fold.
 *
 * That is the difference between "two channels rendered the same edge slightly
 * differently" and "the conversion is wrong".
 *
 * The longitude scaling matters at the same scale: comparing raw degrees treats
 * a degree of longitude as a degree of latitude.
 * At 54°N, this overstates east-west distance by 70%.
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

	// A zero-length segment is a repeated vertex.
	// The distance to it is the distance to the point.
	const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, (px * vx + py * vy) / lengthSquared))

	return Math.hypot(px - t * vx, py - t * vy) * METRES_PER_DEGREE
}

/**
 * The squared distance from a point to a line segment in a planar projection.
 *
 * The answer is in the projection's units squared.
 * For EPSG:27700 those units are meters, and no latitude scaling applies.
 *
 * The squared form saves a square root per comparison.
 * A caller compares it against a squared radius.
 *
 * @category Position
 */
export function planarSegmentDistanceSquared(
	px: number,
	py: number,
	ax: number,
	ay: number,
	bx: number,
	by: number
): number {
	const vx = bx - ax
	const vy = by - ay
	const lengthSquared = vx * vx + vy * vy
	// A zero-length segment is a repeated vertex.
	const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / lengthSquared))
	const dx = ax + t * vx - px
	const dy = ay + t * vy - py

	return dx * dx + dy * dy
}

/**
 * Meters from a point to the nearest ring edge of an areal geometry.
 *
 * `Infinity` when the geometry bounds no area or contains no segment.
 *
 * To the edge rather than to the nearest vertex: a point a centimeter from a long edge can
 * be meters from every vertex of it, so a vertex distance overstates the gap without bound.
 * Measured on the flood layer's verification, one near-miss read 1.58 m to vertices
 * and 0.009 m to edges, a 9 mm difference overstated 175-fold.
 *
 * Every polygon layer's two-path verification measures its boundary tolerance with this.
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
