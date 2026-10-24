/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tiles and TileJSON from the PMTiles archives in R2. The tiger and provider routes serve the same archives
 *   under a longer tile set name, so they call the handlers here.
 */

import { parseTileCoordParams } from "@mailwoman/cartographer/tiles/coords"
import { ResourceError } from "@mailwoman/core/errors"
import { stringifyJSON } from "@mailwoman/core/json"
import type { Context } from "hono"
import { TileType } from "pmtiles"

import { cacheResponse, type TileWorkerHono } from "#caching"
import { CloudflareWorkerPMTiles } from "#protomaps"
import { TileFileExtensionMap, type TileTypeFileExtension } from "#protomaps/files"

/**
 * A tile's last path segment, the row and the file extension, such as `12905.mvt`.
 */
const TILE_FILE = /^(\d+)\.([a-z0-9]+)$/

/**
 * The row and extension of a tile's last path segment, or null when the segment has another shape.
 */
export function parseTileFile(segment: string): { y: string; fileExtension: string } | null {
	const match = TILE_FILE.exec(segment)

	return match ? { y: match[1]!, fileExtension: match[2]! } : null
}

/**
 * The tile set a TileJSON path segment names, such as `planet.v4` for `planet.v4.json`.
 */
export function tileSetOfMetadataFile(segment: string): string {
	return segment.slice(0, -".json".length)
}

/**
 * Serves one tile of `tileSetName` at the request's `z`, `x` and tile file.
 *
 * A coordinate the archive holds no tile for answers 204.
 */
export async function serveTile(c: Context<TileWorkerHono>, tileSetName: string): Promise<Response> {
	const { z, x, tile } = c.req.param() as { z?: string; x?: string; tile?: string }
	const file = parseTileFile(tile ?? "")
	const tileCoords = file ? parseTileCoordParams({ z, x, y: file.y }) : null

	if (!file || !tileCoords) throw ResourceError.from(400, "Invalid tile coordinates")

	const pm = CloudflareWorkerPMTiles.from({
		bucket: c.env.MAILWOMAN_TILES_BUCKET,
		pathPrefix: c.env.PMTILES_PATH,
		tileSetName,
	})

	const tileType = TileFileExtensionMap.get(file.fileExtension as TileTypeFileExtension) || TileType.Unknown
	const tileRange = await pm.retrieveTile({ tileCoords, tileType })

	if (!tileRange) {
		const response = new Response(undefined, { status: 204 })

		cacheResponse(c, response)

		return response
	}

	const response = new Response(tileRange.data, {
		headers: [
			["Content-Type", tileRange.contentType],
			["Etag", tileRange.etag],
			["Cache-Control", tileRange.cacheControl || "public, max-age=86400"],
			["Expires", tileRange.expires],
		].filter((entry): entry is [string, string] => !!entry[1]),
	})

	cacheResponse(c, response)

	return response
}

/**
 * Serves the TileJSON metadata of `tileSetName`.
 * Clients read it before requesting tiles.
 */
export async function serveTileMetadata(c: Context<TileWorkerHono>, tileSetName: string): Promise<Response> {
	const pm = CloudflareWorkerPMTiles.from({
		bucket: c.env.MAILWOMAN_TILES_BUCKET,
		pathPrefix: c.env.PMTILES_PATH,
		tileSetName,
	})

	const tileMetadata = await pm.retrieveTileJSON(tileSetName)

	const response = new Response(stringifyJSON(tileMetadata), {
		headers: {
			"Content-Type": "application/json",
			"Cache-Control": "public, max-age=86400",
		},
		status: 200,
	})

	cacheResponse(c, response)

	return response
}
