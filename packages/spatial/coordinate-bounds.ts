/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Dependency-free WGS-84 coordinate bounds shared by parsers and geometry objects.
 */

/**
 * Southern limit of latitude in WGS-84 degrees.
 */
export const LATITUDE_MIN = -90

/**
 * Northern limit of latitude in WGS-84 degrees.
 */
export const LATITUDE_MAX = 90

/**
 * Western limit of longitude in WGS-84 degrees.
 */
export const LONGITUDE_MIN = -180

/**
 * Eastern limit of longitude in WGS-84 degrees.
 */
export const LONGITUDE_MAX = 180

/**
 * Southern limit of the Web Mercator projection in WGS-84 degrees — the latitude at which the square projection's
 * vertical extent equals its horizontal one.
 */
export const MERCATOR_LATITUDE_MIN = -85.05112878

/**
 * Northern limit of the Web Mercator projection in WGS-84 degrees.
 */
export const MERCATOR_LATITUDE_MAX = 85.05112878

/**
 * Whether a finite number is a latitude on the globe, including both poles.
 */
export function isValidLatitude(value: number): boolean {
	return Number.isFinite(value) && value >= LATITUDE_MIN && value <= LATITUDE_MAX
}

/**
 * Whether a finite number is a longitude on the globe, including the antimeridian.
 */
export function isValidLongitude(value: number): boolean {
	return Number.isFinite(value) && value >= LONGITUDE_MIN && value <= LONGITUDE_MAX
}
