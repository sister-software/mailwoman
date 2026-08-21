/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Great-circle distance utilities. This module imports geometry directly so spatial's
 *   lowest-level math never reaches back through its public barrel.
 */

import { GeoPoint, type GeoPointInput } from "./geometries/point.ts"

/**
 * Conversion factors for converting between degrees and radians.
 *
 * @category Position
 * @see {@link https://en.wikipedia.org/wiki/Radian Wikipedia: Radian}
 * @see {@link https://en.wikipedia.org/wiki/Degree_(angle) Wikipedia: Degree (angle)}
 */
export const ConversionFactor = {
	DegreesToRadians: (Math.PI / 180) as unknown as 0.01745329251,
	RadiansToDegrees: (180 / Math.PI) as unknown as 57.2957795131,
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
