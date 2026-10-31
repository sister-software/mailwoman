/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The shapes a point can arrive in, and the reading of their coordinates.
 *
 *   This module imports no runtime geometry class. `GeoPoint` imports h3-js, and a caller that only needs the
 *   coordinates of a `GeoPointInput` must not pay for the 32 MiB heap that module allocates on first evaluation.
 */

import type { LatLng, LatLngLiteral } from "@googlemaps/google-maps-services-js"
import { tryParsingJSON } from "@mailwoman/core/json"

import { isValidLatitude, isValidLongitude } from "#coordinate/bounds"
import { type GeoObjectLiteral, GeometryType } from "#objects"
import {
	type InternalPointCoordinates,
	type Coordinates2D as Point2DCoordinates,
	type Coordinates3D as Point3DCoordinates,
	isCoordPairLiteral,
	isGoogleMapsLatLngLiteral,
	isInterpolatedCoordinates,
} from "#position"

/**
 * A JSON-serializable single point geometry, such as a specific location,
 * address, or longitude, latitude pair.
 *
 * ```js
 * {
 * 	"type": "Point",
 * 	"coordinates": [100, 0]
 * }
 * ```
 *
 * @title Point Geometry
 * @public
 */
export interface PointLiteral extends GeoObjectLiteral {
	/**
	 * Declares the type of GeoJSON object as a `Point` geometry.
	 */
	type: "Point"
	/**
	 * A pair of coordinates in the form of [longitude, latitude].
	 *
	 * @see {@linkcode Point2DCoordinates} for more information.
	 */
	coordinates: Point2DCoordinates | Point3DCoordinates
}

/**
 * Type-predicate to determine if the given input is a GeoJSON Point geometry.
 */
export function isPointLiteral(input: PointLiteral | null | undefined | unknown): input is PointLiteral {
	if (!input || typeof input !== "object") return false

	if (!("type" in input)) return false

	if (!("coordinates" in input)) return false

	if (input.type !== GeometryType.Point) return false

	return isCoordPairLiteral(input.coordinates)
}

/**
 * Common interface for Browser Geolocation API coordinates.
 *
 * @see {@link https://developer.mozilla.org/en-US/docs/Web/API/GeolocationCoordinates MDN Web Docs}
 */
export interface GeolocationCoordinatesLike {
	latitude: number
	longitude: number
	altitude: number
}

/**
 * Type-predicate to determine if the given input appears to be a {@linkcode GeolocationCoordinatesLike}
 * object — the shape the browser's `GeolocationCoordinates` presents, without depending on the DOM type.
 */
export function isGeolocationCoordinatesLike(input: unknown): input is GeolocationCoordinatesLike {
	if (!input || typeof input !== "object") return false

	if (!("latitude" in input)) return false

	if (!("longitude" in input)) return false

	if (!("altitude" in input)) return false

	return true
}

export type GeoPointInput =
	| PointLiteral
	| Point2DCoordinates
	| Point3DCoordinates
	| GeolocationCoordinatesLike
	| InternalPointCoordinates
	| LatLngLiteral
	| LatLng

/**
 * Reads the `[longitude, latitude(, altitude)]` coordinates out of a point of any accepted shape.
 *
 * It only dispatches on shape: no range check applies, and `null` answers an input
 * that is none of them. {@link readPointCoordinates} adds the validation.
 */
export function pointInputCoordinates(input: unknown): Point2DCoordinates | Point3DCoordinates | null {
	if (isCoordPairLiteral(input)) return input

	if (isPointLiteral(input)) return input.coordinates

	if (isGoogleMapsLatLngLiteral(input)) return [input.lng, input.lat]

	if (isGeolocationCoordinatesLike(input)) return [input.longitude, input.latitude, input.altitude || 0]

	if (isInterpolatedCoordinates(input)) return [input.x, input.y]

	return null
}

/**
 * The coordinates of a point a caller can stand behind, or `null`.
 *
 * Applies the rules of `GeoPoint.from` without constructing one: a string is parsed as JSON, an
 * out-of-range magnitude is rejected rather than repaired, and `(0, 0)` is read as a missing coordinate.
 */
export function readPointCoordinates(input: unknown): Point2DCoordinates | Point3DCoordinates | null {
	if (!input) return null

	if (typeof input === "string") {
		input = tryParsingJSON<GeoPointInput>(input) || tryParsingJSON<GeoPointInput>(`[${input}]`) || input
	}

	const coordinates = pointInputCoordinates(input)

	if (!coordinates) return null

	const [longitude, latitude] = coordinates

	if (!isValidLongitude(longitude) || !isValidLatitude(latitude)) return null

	if (latitude === 0 && longitude === 0) return null

	return coordinates
}
