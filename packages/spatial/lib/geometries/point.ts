/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type google from "@googlemaps/google-maps-services-js"
import type { LatLng, LatLngLiteral } from "@googlemaps/google-maps-services-js"
import { tryParsingJSON } from "@mailwoman/core/objects"
import { convert as convertCoords } from "geo-coordinates-parser"
import { latLngToCell } from "h3-js"

import { type BBox2DLiteral, type BBox3DLiteral, GeoBoundingBox, isBBox } from "#bbox"
import { type H3Cell, shortenH3Cell } from "#h3/cell"
import { type GeoObjectLiteral, GeometryType } from "#objects"
import {
	type InternalPointCoordinates,
	type Coordinates2D as Point2DCoordinates,
	type Coordinates3D as Point3DCoordinates,
	clampLatitude,
	isCoordPairLiteral,
	isGoogleMapsLatLngLiteral,
	isInterpolatedCoordinates,
	isValidLatitude,
	isValidLongitude,
	wrapLongitude,
} from "#position"

/**
 * A JSON-serializeable single point geometry, such as a specific location, address, or longitude, latitude pair.
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
 * Type-predicate to determine if the given input appears to be a {@linkcode GeolocationCoordinates} object.
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

//#region GeoPoint

/**
 * A single point geometry, such as a specific location, address, or longitude, latitude pair.
 */
export class GeoPoint implements PointLiteral {
	//#region Properties

	/**
	 * Declares the type of GeoJSON object as a `Point` geometry.
	 */
	readonly type = GeometryType.Point

	/**
	 * The bounding box literal of the GeoPoint.
	 *
	 * @see {@linkcode GeoPoint.bbox} for the actual bounding box object.
	 * @see {@linkcode GeoBoundingBox} for creating a bounding box.
	 */
	public boundingBox: GeoBoundingBox | null = null

	/**
	 * The bounding box literal of the GeoPoint.
	 *
	 * @see {@linkcode BBox2DLiteral} for 2D bounding boxes.
	 * @see {@linkcode BBox3DLiteral} for 3D bounding boxes.
	 * @see {@linkcode GeoBoundingBox} for creating a bounding box.
	 */
	public get bbox(): BBox2DLiteral | BBox3DLiteral | undefined {
		return this.boundingBox?.toJSON()
	}

	public set bbox(bbox: BBox2DLiteral | BBox3DLiteral | undefined) {
		this.boundingBox = bbox ? new GeoBoundingBox(bbox) : null
	}

	public get coordinates(): Point2DCoordinates | Point3DCoordinates {
		if (this.is3D()) {
			return [this.#longitude, this.#latitude, this.#altitude]
		}

		return [this.#longitude, this.#latitude]
	}

	/**
	 * Assigns the pair as GeoJSON [longitude, latitude(, altitude)] — the axis order is the contract, never inferred from
	 * the magnitudes — and REJECTS a coordinate that is not on the globe. See {@link GeoPoint.from} for why both halves of
	 * that sentence are required.
	 *
	 * @throws {RangeError} When longitude is outside [-180, 180] or latitude is outside [-90, 90].
	 */
	public set coordinates(coords: Point2DCoordinates | Point3DCoordinates) {
		const [longitude, latitude, altitude] = coords

		if (!isValidLongitude(longitude) || !isValidLatitude(latitude)) {
			throw new RangeError(
				`GeoPoint expects GeoJSON [longitude, latitude] with longitude in [-180, 180] and latitude in [-90, 90]; got [${longitude}, ${latitude}]`
			)
		}

		this.#longitude = longitude
		this.#latitude = latitude
		this.#altitude = typeof altitude === "number" ? altitude : 0
	}

	#latitude = 0
	#longitude = 0
	#altitude = 0

	/**
	 * The longitude of the point in degrees, i.e. the x-coordinate.
	 *
	 * Values outside the range will be wrapped around to the opposite side of the globe.
	 *
	 * @minimum -180
	 * @maximum 180
	 */
	public get longitude(): number {
		return this.#longitude
	}

	public set longitude(value: number) {
		this.#longitude = wrapLongitude(value)
	}

	/**
	 * The latitude of the point in degrees, i.e. the y-coordinate.
	 *
	 * Values outside the range will be clamped to the poles.
	 *
	 * @minimum -90
	 * @maximum 90
	 */
	public get latitude(): number {
		return this.#latitude
	}

	public set latitude(value: number) {
		this.#latitude = clampLatitude(value)
	}

	/**
	 * The altitude of the point, i.e. the z-coordinate.
	 *
	 * This is optional and is typically measured in meters.
	 */
	public get altitude(): number {
		return this.#altitude
	}

	public set altitude(value: number) {
		this.#altitude = value
	}

	//#endregion

	//#region Constructors

	/**
	 * Create a new GeoPoint object with default coordinates.
	 */
	constructor()
	/**
	 * Create a new GeoPoint instance from another {@linkcode GeoJSONPosition} coordinates.
	 */
	constructor(
		geoJSONPosition: Point2DCoordinates | Point3DCoordinates,
		bbox?: BBox2DLiteral | BBox3DLiteral | GeoBoundingBox
	)

	/**
	 * Create a new GeoPoint instance from the browser's Geolocation API coordinates.
	 *
	 * @see {@link https://developer.mozilla.org/en-US/docs/Web/API/GeolocationCoordinates MDN Web Docs}
	 */
	constructor(geoLocationCoordinates: GeolocationCoordinatesLike, bbox?: BBox2DLiteral | BBox3DLiteral | GeoBoundingBox)

	/**
	 * Creates a new GeoPoint instance from a Google Maps API {@linkcode google.LatLngLiteral | LatLngLiteral} object.
	 */
	constructor(latLngLiteral: google.LatLngLiteral, bbox?: BBox2DLiteral | BBox3DLiteral | GeoBoundingBox)

	/**
	 * Creates a new GeoPoint instance from internal coordinates.
	 */
	constructor(interpolatedCoords: InternalPointCoordinates, bbox?: BBox2DLiteral | BBox3DLiteral | GeoBoundingBox)
	/**
	 * Creates a new GeoPoint instance from a Google Maps API {@linkcode google.LatLng | LatLng} object.
	 */
	constructor(latLng: LatLngLiteral, bbox?: BBox2DLiteral | BBox3DLiteral | GeoBoundingBox)
	/**
	 * Create a new GeoPoint instance from another {@linkcode PointLiteral}.
	 */
	constructor(geoPointJSON: PointLiteral, bbox?: BBox2DLiteral | BBox3DLiteral | GeoBoundingBox)

	/**
	 * Create a new GeoPoint instance.
	 */
	constructor(input: GeoPointInput, bbox?: BBox2DLiteral | BBox3DLiteral | GeoBoundingBox)
	constructor(input?: GeoPointInput, bbox?: BBox2DLiteral | BBox3DLiteral | GeoBoundingBox) {
		if (isCoordPairLiteral(input)) {
			this.coordinates = input
		} else if (isPointLiteral(input)) {
			this.coordinates = [...input.coordinates]

			if (isBBox(input.bbox)) {
				this.bbox = [...input.bbox]
			}
		} else if (isGoogleMapsLatLngLiteral(input)) {
			this.coordinates = [input.lng, input.lat]
		} else if (isGeolocationCoordinatesLike(input)) {
			this.coordinates = [input.longitude, input.latitude, input.altitude || 0]
		} else if (isInterpolatedCoordinates(input)) {
			this.coordinates = [input.x, input.y]
		} else {
			this.coordinates = [0, 0]
		}

		if (isBBox(bbox)) {
			this.bbox = bbox
		}
	}

	/**
	 * Attempts to create a new GeoPoint instance from the given input, returning `null` rather than throwing when the
	 * input is not a coordinate this class will stand behind.
	 *
	 * Two rules, both of which this constructor got wrong until 2026-08-05 (the defect was recorded in `e9bfd139` and
	 * routed around rather than fixed):
	 *
	 * 1. **A 2-tuple is GeoJSON [longitude, latitude]. The axis order is never inferred.** The old path ran the pair through
	 *    `inferGeoJSONCoordOrder`, whose only signal is the [-90, 90] latitude range, so it transposed a pair exactly
	 *    when |the second magnitude| > 90. A caller handing it `[latitude, longitude]` therefore got the pair repaired in
	 *    Dallas and left corrupted in Berlin — behaviour selected by the data, from one code path. This change is a no-op
	 *    for every WELL-FORMED input: a valid `[longitude, latitude]` pair can never have an out-of-range second element,
	 *    so the heuristic never fired on one.
	 * 2. **An out-of-range magnitude is rejected, not repaired.** `[999, 999]` used to produce a GeoPoint reporting latitude 999.
	 *    It now returns `null` here and throws a `RangeError` from the constructor. Note the deliberate asymmetry with
	 *    the scalar `longitude` / `latitude` setters, which still wrap and clamp: mutating a point is a pan gesture,
	 *    where 190° meaning -170° is right; PARSING one is a claim about the world, where an impossible magnitude means
	 *    the input was malformed and any repair invents a location.
	 *
	 * A 0/0 result is treated as the "missing coordinate" sentinel (Null Island) and also returns `null`.
	 */
	static from(input: unknown): GeoPoint | null {
		if (!input) return null

		if (input instanceof GeoPoint) return input

		if (typeof input === "string") {
			const coordinates = tryParsingJSON<GeoPointInput>(input) || tryParsingJSON<GeoPointInput>(`[${input}]`)

			if (coordinates) {
				input = coordinates
			}
		}

		try {
			const point = new GeoPoint(input as GeoPointInput)

			if (point.isNullIsland()) return null

			return point
		} catch {
			return null
		}
	}

	//#endregion

	//#region Predicates

	/**
	 * Whether the GeoPoint is 2-dimensional.
	 */
	public is2D() {
		return !this.is3D()
	}

	/**
	 * Whether the GeoPoint is 3-dimensional.
	 */
	public is3D() {
		return this.#altitude !== 0
	}

	/**
	 * Whether the GeoPoint is the null island at 0, 0.
	 */
	public isNullIsland(): boolean {
		return this.#latitude === 0 && this.#longitude === 0
	}

	//#endregion

	//#region Conversion

	public toJSON(): PointLiteral {
		return {
			type: this.type,
			coordinates: this.coordinates,
		}
	}

	public to2DCoordinates(): Point2DCoordinates {
		return [this.#longitude, this.#latitude]
	}

	public to3DCoordinates(): Point3DCoordinates {
		return [this.#longitude, this.#latitude, this.#altitude]
	}

	/**
	 * Converts the GeoPoint to a Google Maps API {@linkcode google.LatLngLiteral | LatLngLiteral} object.
	 */
	public toGoogleLatLngLiteral(): google.LatLngLiteral {
		return {
			lat: this.#latitude,
			lng: this.#longitude,
		}
	}

	/**
	 * Converts the GeoPoint to DMS (Degrees, Minutes, Seconds) format.
	 */
	public toDMS(): string {
		const converter = convertCoords(`${this.#latitude},${this.#longitude}`)

		return converter.toCoordinateFormat("DMS")
	}

	/**
	 * Converts the GeoPoint to a H3 short cell address.
	 */
	public toH3Cell(resolution = 15) {
		const cell = latLngToCell(this.#latitude, this.#longitude, resolution) as H3Cell

		return cell
	}

	/**
	 * Converts the GeoPoint to a H3 short cell address.
	 */
	public toH3ShortCell(resolution = 15) {
		const cell = this.toH3Cell(resolution)

		return shortenH3Cell(cell)
	}

	public toString(): string {
		return JSON.stringify(this.toJSON())
	}
	//#endregion

	public [Symbol.iterator](): Iterator<number> {
		return this.coordinates[Symbol.iterator]()
	}
}

/**
 * An array of positions for each point in the geometry.
 *
 * @see {@linkcode GeoJSONPosition} for more information.
 */
export type MultiPointPath = [...points: Array<Point2DCoordinates | Point3DCoordinates>]

/**
 * A collection of points, such as a constellation or a set of locations.
 */
export interface MultiPointLiteral extends GeoObjectLiteral {
	/**
	 * Declares the type of GeoJSON object as a `MultiPoint` geometry.
	 */
	type: "MultiPoint"
	/**
	 * An array of positions for each point in the geometry.
	 *
	 * @see {@linkcode GeoJSONPosition} for more information.
	 */
	coordinates: MultiPointPath
}
