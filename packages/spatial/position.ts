/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   This file contains types and utilities for working with geographic positions.
 */

import type { LatLngLiteral } from "@googlemaps/google-maps-services-js"

import { isValidLatitude, isValidLongitude } from "./coordinate-bounds.ts"

export { isValidLatitude, isValidLongitude } from "./coordinate-bounds.ts"

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
 * Infers GeoJSON `[longitude, latitude]` order from coordinate bounds.
 *
 * @returns The coordinates ordered as [longitude, latitude] when exactly one possible ordering is valid.
 * @throws {RangeError} When axis order is ambiguous or coordinates are invalid.
 */
export function inferGeoJSONCoordOrder([coordA, coordB]: [number, number]): Coordinates2D {
	const geoJSONIsValid = isValidLongitude(coordA) && isValidLatitude(coordB)
	const latLonIsValid = isValidLatitude(coordA) && isValidLongitude(coordB)

	if (geoJSONIsValid && !latLonIsValid) {
		return [coordA, coordB]
	}

	if (latLonIsValid && !geoJSONIsValid) {
		return [coordB, coordA]
	}

	if (geoJSONIsValid && latLonIsValid) {
		throw new RangeError(`Cannot infer coordinate order: [${coordA}, ${coordB}] is valid in both axis orders.`)
	}

	throw new RangeError(`Invalid coordinate pair: [${coordA}, ${coordB}].`)
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
