/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { parseTileCoordParams } from "@mailwoman/cartographer/tiles/coords"
import { ResourceError } from "@mailwoman/core/errors"
import { TileType } from "pmtiles"

import { cacheResponse } from "../caching.ts"
import { applyAccessControlAllowOrigin } from "../cors.ts"
import { TileFileExtensionMap, type TileTypeFileExtension } from "../protomaps/files.ts"
import { CloudflareWorkerPMTiles } from "../protomaps/index.ts"
import { WorkerRoute } from "../routing.ts"

//#region Tile Retrieval

export const TileRoute = WorkerRoute.GET(
	"/:tileSetName([a-zA-Z0-9_\\-]+)/:z(\\d+)/:x(\\d+)/:y(\\d+).:fileExtension([a-z0-9]+)",
	async ({ request, params, env, ctx }) => {
		const tileCoords = parseTileCoordParams(params)!

		if (!tileCoords) throw ResourceError.from(400, "Invalid tile coordinates")

		const { tileSetName, fileExtension } = params

		const pm = CloudflareWorkerPMTiles.from({
			bucket: env.NEXUS_ASSETS_BUCKET,
			pathPrefix: env.PMTILES_PATH,
			tileSetName,
		})

		const tileType = TileFileExtensionMap.get(fileExtension as TileTypeFileExtension) || TileType.Unknown

		const tileRange = await pm.retrieveTile({ tileCoords, tileType })

		if (!tileRange) {
			const response = new Response(undefined, { status: 204 }) // No content
			applyAccessControlAllowOrigin(request, response)

			cacheResponse(response, { request, ctx })

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

		applyAccessControlAllowOrigin(request, response)

		cacheResponse(response, { request, ctx })

		return response
	}
)

//#endregion

//#region Metadata Lookup

export const TileMetadataRoute = WorkerRoute.GET(
	"/:tileSetName([a-zA-Z0-9_\\-]+).json",
	async ({ ctx, request, env, params }) => {
		const { tileSetName } = params

		const pm = CloudflareWorkerPMTiles.from({
			bucket: env.NEXUS_ASSETS_BUCKET,
			pathPrefix: env.PMTILES_PATH,
			tileSetName,
		})

		const tileMetadata = await pm.retrieveTileJSON(tileSetName)

		const response = new Response(JSON.stringify(tileMetadata), {
			headers: {
				"Content-Type": "application/json",
				"Cache-Control": "public, max-age=86400",
			},
			status: 200,
		})

		applyAccessControlAllowOrigin(request, response)

		cacheResponse(response, { request, ctx })

		return response
	}
)

//#endregion
