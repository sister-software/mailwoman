/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { TileType } from "pmtiles"

/**
 * File extensions a tile response may use, used to pick the content type and reject anything else.
 */
const TileTypeFileExtensions = new Set(["avif", "bin", "jpg", "mvt", "png", "webp"] as const)

export type TileTypeFileExtension = typeof TileTypeFileExtensions extends Set<infer T> ? T : never

/**
 * PM Tile file extension to tile type.
 *
 * `bin` is a tile type PMTiles has no name for, such as the gzipped compact
 * building tiles `hrt building-tiles` writes.
 * Its archive records the tile type `Unknown`.
 */
export const TileFileExtensionMap = new Map([
	["avif", TileType.Avif],
	["bin", TileType.Unknown],
	["jpg", TileType.Jpeg],
	["mvt", TileType.Mvt],
	["png", TileType.Png],
	["webp", TileType.Webp],
]) satisfies ReadonlyMap<TileTypeFileExtension, TileType>

/**
 * PM Tile type to file extension.
 */
export const TileTypeFileExtensionMap = new Map(
	Array.from(TileFileExtensionMap).map(([k, v]) => [v, k] as const)
) as ReadonlyMap<TileType, TileTypeFileExtension>

/**
 * PM tile types to content types.
 */
export const TileTypeToContentType = {
	[TileType.Unknown]: "application/octet-stream",
	[TileType.Avif]: "image/avif",
	[TileType.Jpeg]: "image/jpeg",
	[TileType.Mvt]: "application/x-protobuf",
	[TileType.Mlt]: "application/x-protobuf",
	[TileType.Png]: "image/png",
	[TileType.Webp]: "image/webp",
} as const satisfies Record<TileType, string>
