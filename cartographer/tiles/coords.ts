/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

/** Parts in a `z/x/y` tile coordinate. */
const TILE_COORD_PARTS = 3

/**
 * Literal type for a tile coord array.
 */
export type TileCoords = [zoom: number, xCoord: number, yCoord: number]

export function parseTileCoordParams({ z, x, y }: Record<string, string | undefined>): TileCoords | null {
	const coords = [z, x, y].map((n) => Number.parseInt(n!, 10)).filter((n) => !Number.isNaN(n))

	if (coords.length !== TILE_COORD_PARTS) return null

	return coords as TileCoords
}

/*
 * Get the precise fractional tile location for a point at a zoom level
 *
 */
export function pointToTileFraction(zoom: number, longitude: number, latitude: number): TileCoords {
	const sin = Math.sin((latitude * Math.PI) / 180)
	const z2 = Math.pow(2, zoom)
	let x = z2 * (longitude / 360 + 0.5)

	const y = z2 * (0.5 - (0.25 * Math.log((1 + sin) / (1 - sin))) / Math.PI)

	// Wrap Tile X
	x = x % z2

	if (x < 0) {
		x = x + z2
	}

	return [zoom, x, y]
}

/**
 * Get the tile for a point at a specified zoom level
 */
export function pointToTile(zoom: number, longitude: number, latitude: number): TileCoords {
	const [, x, y] = pointToTileFraction(zoom, longitude, latitude)

	return [zoom, Math.floor(x), Math.floor(y)]
}
