/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   This file contains types and utilities for working with geographic positions.
 */

import type { LatLngLiteral } from "@googlemaps/google-maps-services-js"
import { GeoPoint, type GeoPointInput } from "@mailwoman/spatial"

/**
 * Southern limit of latitude in WGS84 degrees. Outside it a value cannot be a latitude.
 */
const LATITUDE_MIN = -90

/**
 * Northern limit of latitude in WGS84 degrees.
 */
const LATITUDE_MAX = 90

/**
 * Western limit of longitude in WGS84 degrees (the antimeridian, which is itself a valid longitude).
 */
const LONGITUDE_MIN = -180

/**
 * Eastern limit of longitude in WGS84 degrees.
 */
const LONGITUDE_MAX = 180

/**
 * Whether a number is a latitude a point can actually sit at: finite, and within [-90, 90] inclusive (the poles count).
 * Distinct from {@link clampLatitude}, which folds an out-of-range value onto the nearest pole — clamping is right for a
 * viewport edge and wrong for a coordinate, where an out-of-range value means the input was malformed and the repaired
 * point is fiction.
 *
 * @category Position
 */
export function isValidLatitude(value: number): boolean {
	return Number.isFinite(value) && value >= LATITUDE_MIN && value <= LATITUDE_MAX
}

/**
 * Whether a number is a longitude a point can actually sit at: finite, and within [-180, 180] inclusive. Same
 * distinction from {@link wrapLongitude} that {@link isValidLatitude} draws from `clampLatitude` — wrapping 190° to -170°
 * is correct for a pan gesture and a silent relocation for a parsed coordinate.
 *
 * @category Position
 */
export function isValidLongitude(value: number): boolean {
	return Number.isFinite(value) && value >= LONGITUDE_MIN && value <= LONGITUDE_MAX
}

/**
 * Arity of a `[lon, lat]` coordinate tuple.
 */
const COORD_PAIR_LENGTH = 2

/**
 * Arity of a `[lon, lat, elevation]` coordinate tuple.
 */
const COORD_TRIPLE_LENGTH = 3

/**
 * An ordered pair of coordinates in the form of [longitude, latitude].
 *
 * Note that unlike the typical order, GeoJSON coordinates are in the order of [longitude, latitude] to match the order
 * of [x, y] in Cartesian coordinates.
 *
 * @category Position
 * @category GeoJSON
 * @see {@linkcode Coordinates3D} for 3D coordinates.
 */
export type Coordinates2D = [
	/**
	 * The longitude of the point, i.e. the x-coordinate.
	 *
	 * @minimum -180
	 * @maximum 180
	 */
	longitude: number,
	/**
	 * The latitude of the point, i.e. the y-coordinate.
	 *
	 * @minimum -90
	 * @maximum 90
	 */
	latitude: number,
]

/**
 * Orders the given coordinates as [longitude, latitude].
 *
 * This is useful when converting into GeoJSON format.
 *
 * @category GeoJSON
 * @category Position
 */
export function orderCoordPairToGeoJSON([latitude, longitude]: [number, number]): Coordinates2D {
	return [longitude, latitude]
}

/**
 * Orders the given coordinates as [latitude, longitude].
 *
 * This is useful when converting into Google Maps format.
 *
 * @category GeoJSON
 * @category Position
 */
export function orderGeoJSONToCoordPair([longitude, latitude]: Coordinates2D): [number, number] {
	return [latitude, longitude]
}

/**
 * Given an input which appears to be reversed GeoJSON coordinates (i.e. [latitude, longitude]), returns the coordinates
 * in the correct order of [longitude, latitude].
 *
 * **This cannot do what its name promises, and nothing in this repo calls it.** The only signal it has is the [-90, 90]
 * latitude range, so it transposes a pair only when the SECOND magnitude falls outside that range — i.e. only where
 * |longitude| > 90. It is therefore inert across every longitude in [-90, 90]: all of Europe and Africa, western
 * Russia, the Middle East, India, and the Atlantic. A caller who hands it `[latitude, longitude]` gets the pair
 * repaired in Dallas and left corrupted in Berlin, from one code path, decided by the data. That is why `GeoPoint`
 * stopped calling it on 2026-08-05 (recorded in `e9bfd139`; `registry/tools/geocoder-vs-provided-coords.ts` had already
 * routed around it) and now reads a 2-tuple as GeoJSON [longitude, latitude], full stop.
 *
 * Retained as an explicit, opt-in escape hatch for a caller who knows their source is lat-first AND North American. If
 * you know the axis order, use {@link orderCoordPairToGeoJSON}; if you do not, no function can tell you.
 *
 * @deprecated Axis order is metadata, not something a magnitude can recover. Prefer `orderCoordPairToGeoJSON`.
 * @category GeoJSON
 * @category Position
 */
export function inferGeoJSONCoordOrder([coordA, coordB]: [number, number]): Coordinates2D {
	// Latitude values typically range from -90 to 90
	const isCoordALat = coordA >= LATITUDE_MIN && coordA <= LATITUDE_MAX
	const isCoordBLat = coordB >= LATITUDE_MIN && coordB <= LATITUDE_MAX

	if (isCoordALat && !isCoordBLat) {
		// coordA is latitude, coordB is longitude
		return [coordB, coordA]
	}

	if (!isCoordALat && isCoordBLat) {
		// coordB is latitude, coordA is longitude
		return [coordA, coordB]
	}

	// In case both appear to be latitudes (unlikely) or longitudes (out of range for US),
	// assume coordA is longitude and coordB is latitude as default.
	return [coordA, coordB]
}

/**
 * An ordered triple of coordinates in the form of [longitude, latitude, altitude].
 *
 * @category Position
 * @category GeoJSON
 * @see {@linkcode Coordinates2D} for 2D coordinates.
 */
export type Coordinates3D = [
	/**
	 * The longitude of the point, i.e. the x-coordinate.
	 *
	 * @minimum -180
	 * @maximum 180
	 */
	longitude: number,
	/**
	 * The latitude of the point, i.e. the y-coordinate.
	 *
	 * @minimum -90
	 * @maximum 90
	 */
	latitude: number,
	/**
	 * The altitude of the point, i.e. the z-coordinate.
	 */
	altitude: number,
]

/**
 * A record of internal coordinates, typically used by the US Census.
 */
export interface InternalPointCoordinates {
	/**
	 * Internal Longitude (X) Coordinates
	 *
	 * @minimum -180
	 * @maximum 180
	 */
	x: number
	/**
	 * Internal Latitude (Y) Coordinates
	 *
	 * @minimum -90
	 * @maximum 90
	 */
	y: number
}

/**
 * Type-predicate to determine if the given input is a GeoJSON Point geometry.
 *
 * @category Type Predicates
 * @category GeoJSON
 */
export function isCoordPairLiteral(input: unknown): input is [number, number] | [number, number, number] {
	if (!Array.isArray(input)) return false

	if (input.length !== COORD_PAIR_LENGTH && input.length !== COORD_TRIPLE_LENGTH) return false

	return input.every((coord) => typeof coord === "number")
}

/**
 * Type-predicate to determine if the given input is a {@linkcode LatLngLiteral} object.
 *
 * @category Position
 * @category Type Predicates
 * @see {@link https://developers.google.com/maps/documentation/javascript/reference/coordinates#LatLngLiteral Google Maps API Documentation}
 */
export function isGoogleMapsLatLngLiteral(input: unknown): input is LatLngLiteral {
	if (!input || typeof input !== "object") return false

	if (!Object.hasOwn(input, "lat") || !Object.hasOwn(input, "lng")) return false

	return true
}

/**
 * Type-predicate to determine if the given input is a {@linkcode InternalPointCoordinates} object.
 *
 * @category Position
 * @category Type Predicates
 */
export function isInterpolatedCoordinates(input: unknown): input is InternalPointCoordinates {
	if (!input || typeof input !== "object") return false

	if (!("x" in input)) return false

	if (!("y" in input)) return false

	return typeof input.x === "number" && typeof input.y === "number"
}

/**
 * Given a longitude value, wraps it to the range of [-180, 180].
 *
 * This is useful when normalizing longitude values.
 *
 * @category Position
 * @param longitude The longitude value to wrap.
 */
export function wrapLongitude(longitude: number): number {
	return ((((longitude + 180) % 360) + 360) % 360) - 180
}

/**
 * Given a latitude value, clamps it to the range of [-90, 90].
 *
 * This is useful when normalizing latitude values.
 *
 * @category Position
 * @param value The latitude value to clamp.
 */
export function clampLatitude(value: number): number {
	return Math.min(90, Math.max(-90, value))
}

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
 * Radius of the Earth in various units
 */
const RADII = {
	km: 6371,
	miles: 3958.8,
	meters: 6_371_000,
} as const satisfies Record<EarthRadiusUnit, number>

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
/**
 * Shared great-circle math (no sentinel handling). `unit` selects the Earth radius.
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
