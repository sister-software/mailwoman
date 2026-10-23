/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The names of the published Protomaps tile artifacts.
 *
 *   The module holds only string constants, so a browser or worker bundle that needs a tileset name loads
 *   no path builder and no environment reader. The URL builders that read those live in `asset-paths.ts`.
 */

/**
 * The version of the Protomaps library used for tile generation.
 */
export const PROTOMAPS_VERSION = "v4"

/**
 * The prefix within the tiles bucket for Protomaps tiles.
 */
export const PROTOMAPS_TILE_PREFIX = "tiles"

/**
 * The file name of the Protomaps planet file, without its extension.
 */
export const PROTOMAPS_PLANET_TILESET_NAME = `planet.${PROTOMAPS_VERSION}`

/**
 * The file name of the Protomaps planet file.
 */
export const PROTOMAPS_PLANET_FILE_NAME = `${PROTOMAPS_PLANET_TILESET_NAME}.pmtiles`
