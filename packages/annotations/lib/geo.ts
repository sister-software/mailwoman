/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The coordinate shapes every workspace reads: a WGS-84 point spelled two ways, a plain bounds
 *   rectangle, and the geocoder resolution tier. This module has no imports so a browser bundle and
 *   a dependency-lean command can both name them.
 */

/**
 * A WGS-84 point in decimal degrees, spelled with the `latitude` and `longitude` field names.
 *
 * Latitude is positive north and longitude is positive east.
 * A caller that carries a coordinate on a different ellipsoid must track that ellipsoid itself.
 *
 * The same numbers name different places on Airy 1830 and on GRS80.
 */
export interface GeoCoordinate {
	latitude: number
	longitude: number
}

/**
 * A WGS-84 point in decimal degrees, spelled with the `lat` and `lon` field names.
 *
 * Wire shapes and database rows that store a point under these keys read this type.
 */
export interface LatLon {
	lat: number
	lon: number
}

/**
 * Plain latitude and longitude bounds in decimal degrees: four numbers with no state or behavior.
 *
 * A query filter, a declared extract extent, and a place's stored box all read this type.
 */
export interface LatLonBounds {
	minLat: number
	maxLat: number
	minLon: number
	maxLon: number
}

/**
 * The geocoder resolution tier that produced a coordinate.
 *
 * `admin` results carry no uncertainty estimate.
 * The tier names are a JSON contract, matching `GeocodeResult.resolution_tier`
 * and the gauntlet's `expect_tier` column.
 */
export type ResolutionTier = "address_point" | "interpolated" | "street" | "admin" | "venue" | "plus_code"
