/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The city models Earth serves from its own tile worker, whatever source each came from.
 *
 *   `data/city-tilesets.json` lists them. The converter for each source writes the tileset as 3D Tiles 1.1 under
 *   `3dtiles/<id>/` in the tiles bucket and adds its record here, so the map reads one list for every city.
 */

/**
 * A city source the converter reads.
 */
export const CitySource = {
	/**
	 * Japan's Project PLATEAU, textured LoD2 buildings.
	 */
	plateau: "plateau",
} as const

export type CitySource = (typeof CitySource)[keyof typeof CitySource]

/**
 * One converted city tileset.
 */
export interface CityTileset {
	/**
	 * The tileset's directory under `3dtiles/` on the tile worker, from the
	 * source tileset's own directory name.
	 */
	id: string
	source: CitySource
	/**
	 * The source tileset the conversion read.
	 */
	sourceURL: string
	/**
	 * The source's license record title.
	 * The source's license election reads it.
	 */
	licenseTitle: string | null
	/**
	 * The tileset root's extent as `[west, south, east, north]` in degrees.
	 */
	bounds: [number, number, number, number]
	/**
	 * The geoid height in meters at the tileset's center.
	 *
	 * The source's heights are ellipsoidal, and the map's ground is the geoid,
	 * so the renderer lowers the tileset by this much.
	 */
	geoidHeight: number
	/**
	 * Converted content files, and their gzipped bytes as stored.
	 */
	tiles: number
	bytes: number
}

/**
 * The path of a converted tileset's root on the tile worker, such as `3dtiles/<id>/tileset.json`.
 */
export function cityTilesetPath({ id }: Pick<CityTileset, "id">): string {
	return `3dtiles/${id}/tileset.json`
}
