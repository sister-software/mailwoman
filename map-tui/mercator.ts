/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

/**
 * Web-Mercator projection math for map-tui.
 *
 * This module reimplements the standard Web-Mercator projection (EPSG:3857) math locally rather than importing from
 * @mailwoman/cartographer or @mailwoman/spatial. The cartographer dependency drags maplibre-gl + @mailwoman/tiger;
 * spatial drags @mailwoman/core's shipped data. map-tui maintains a dependency-lean surface for the standalone `npx`
 * story (the nuts-lookup precedent).
 */

/**
 * Number of pixels per tile in the Web-Mercator projection (standard: 256).
 */
export const TILE_SIZE = 256

export interface LonLat {
	lon: number
	lat: number
}

export interface WorldPx {
	x: number
	y: number
}

export function lonLatToWorldPx(lon: number, lat: number, zoom: number): WorldPx {
	const scale = TILE_SIZE * 2 ** zoom
	const sin = Math.sin((lat * Math.PI) / 180)

	return {
		x: scale * (lon / 360 + 0.5),
		y: scale * (0.5 - (0.25 * Math.log((1 + sin) / (1 - sin))) / Math.PI),
	}
}

export function worldPxToLonLat(x: number, y: number, zoom: number): LonLat {
	const scale = TILE_SIZE * 2 ** zoom
	const n = Math.PI * (1 - (2 * y) / scale)

	return {
		lon: (x / scale - 0.5) * 360,
		lat: (Math.atan(Math.sinh(n)) * 180) / Math.PI,
	}
}

const EARTH_CIRCUMFERENCE_M = 40_075_016.686

export function metersPerPixel(lat: number, zoom: number): number {
	return (EARTH_CIRCUMFERENCE_M * Math.cos((lat * Math.PI) / 180)) / (TILE_SIZE * 2 ** zoom)
}
