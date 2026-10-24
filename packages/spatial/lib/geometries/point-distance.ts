/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Great-circle distances between `GeoPointInput` values.
 *
 *   These take the object form, so they import `GeoPoint`, and through it h3-js. A caller with plain coordinates uses
 *   `haversineKm` or `centralAngle` from `#distance`, which import neither.
 */

import { BODY_RADII_KM, centralAngle, EARTH_RADII, type EarthRadiusUnit, type GreatCircleOptions } from "#distance"
import { GeoPoint, type GeoPointInput } from "#geometries/point"

/**
 * Calculate the distance between two points on the Earth's surface.
 *
 * The object form's `(0, 0)` sentinel applies: a `(0, 0)` input answers `NaN`.
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

	return EARTH_RADII[unit] * centralAngle(p1.latitude, p1.longitude, p2.latitude, p2.longitude)
}

/**
 * Great-circle distance on the selected body. {@link haversine} is this function on Earth.
 * A caller with a body passes it here.
 *
 * The object form's `(0, 0)` sentinel applies: a `(0, 0)` input answers `NaN`.
 *
 * @category Position
 */
export function greatCircleDistance(
	point1: GeoPointInput,
	point2: GeoPointInput,
	options: GreatCircleOptions = {}
): number {
	const unit = options.unit ?? "km"
	const body = options.body ?? "earth"
	const scale = BODY_RADII_KM[body] / BODY_RADII_KM.earth

	return haversine(point1, point2, unit) * scale
}
