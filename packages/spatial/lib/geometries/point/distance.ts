/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Great-circle distances between `GeoPointInput` values or plain coordinates.
 *
 *   This module imports no runtime geometry class. `GeoPoint` imports h3-js, and a distance must not pay for that.
 *   Points are read through `#geometries/point/coordinates` instead.
 */

import { BODY_RADII_KM, centralAngle, EARTH_RADII, type EarthRadiusUnit, type GreatCircleOptions } from "#distance"
import { type GeoPointInput, readPointCoordinates } from "#geometries/point/coordinates"

/**
 * A coordinate component that may be absent, such as a geocoder's `lat` and `lon` when it returned no point.
 */
type MaybeCoordinate = number | null | undefined

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
export function haversine(point1: GeoPointInput, point2: GeoPointInput, unit?: EarthRadiusUnit): number

/**
 * Calculate the distance between two coordinates in decimal degrees on the Earth's surface.
 *
 * Unlike the object form, this is pure math with no Null-Island sentinel: `(0, 0)` is
 * the Gulf of Guinea — a real point rather than a "missing coordinate".
 *
 * @category Position
 * @returns The distance between the two coordinates in the specified unit.
 */
export function haversine(aLat: number, aLon: number, bLat: number, bLon: number, unit?: EarthRadiusUnit): number

/**
 * Calculate the distance between two coordinates, either of which may be absent.
 *
 * Answers `null` when any component is `null` or `undefined`, so a geocoder's
 * `{ lat: number | null, lon: number | null }` pair needs no guard or non-null assertion.
 *
 * @category Position
 * @returns The distance in the specified unit, or `null` when a component is absent.
 */
export function haversine(
	aLat: MaybeCoordinate,
	aLon: MaybeCoordinate,
	bLat: MaybeCoordinate,
	bLon: MaybeCoordinate,
	unit?: EarthRadiusUnit
): number | null

export function haversine(
	...args:
		| [point1: GeoPointInput, point2: GeoPointInput, unit?: EarthRadiusUnit]
		| [
				aLat: MaybeCoordinate,
				aLon: MaybeCoordinate,
				bLat: MaybeCoordinate,
				bLon: MaybeCoordinate,
				unit?: EarthRadiusUnit,
		  ]
): number | null {
	const [first] = args

	if (typeof first === "object" && first !== null) {
		const [point1, point2, unit = "km"] = args as [GeoPointInput, GeoPointInput, EarthRadiusUnit?]
		const p1 = readPointCoordinates(point1)
		const p2 = readPointCoordinates(point2)

		if (!p1 || !p2) return Number.NaN

		return EARTH_RADII[unit] * centralAngle(p1[1], p1[0], p2[1], p2[0])
	}

	const [aLat, aLon, bLat, bLon, unit = "km"] = args as [
		MaybeCoordinate,
		MaybeCoordinate,
		MaybeCoordinate,
		MaybeCoordinate,
		EarthRadiusUnit?,
	]

	if (aLat == null || aLon == null || bLat == null || bLon == null) return null

	return EARTH_RADII[unit] * centralAngle(aLat, aLon, bLat, bLon)
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
