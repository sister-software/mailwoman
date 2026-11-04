/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   MapLibre's mercator world, the 0..1 square the custom layers' projection matrices take.
 */

import { toMercator } from "@mailwoman/spatial/coordinate/formats"

/**
 * The circumference of MapLibre's mercator sphere at the equator, in meters.
 */
export const EARTH_CIRCUMFERENCE = 2 * Math.PI * 6_378_137

/**
 * A longitude and latitude in MapLibre's mercator world: x east from 0 at the antimeridian,
 * y south from 0 at the top of the square, both reaching 1.
 */
export function mercatorWorld(longitude: number, latitude: number): [number, number] {
	const meters = toMercator(latitude, longitude)

	return [0.5 + meters.x / EARTH_CIRCUMFERENCE, 0.5 - meters.y / EARTH_CIRCUMFERENCE]
}
