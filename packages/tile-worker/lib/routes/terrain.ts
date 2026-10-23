/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { parseTileCoordParams } from "@mailwoman/cartographer/tiles/coords"
import { ResourceError } from "@mailwoman/core/errors"

import { cacheResponse } from "#caching"
import { applyAccessControlAllowOrigin } from "#cors"
import { WorkerRoute } from "#routing"

/**
 * The AWS Open Data terrain tiles (Tilezen Joerd), in the terrarium PNG encoding.
 */
const TERRARIUM_ORIGIN = "https://elevation-tiles-prod.s3.amazonaws.com/terrarium"

/**
 * The deepest zoom the bucket publishes.
 */
const TERRARIUM_MAX_ZOOM = 15

/**
 * Serves a terrarium elevation tile by z/x/y from Cloudflare's edge cache,
 * filling a miss from the AWS bucket.
 *
 * The bucket answers over HTTP/1.1 with no `Cache-Control`, so a browser opens a
 * connection per few tiles and revalidates on revisit.
 * Served here, the tiles share the basemap's HTTP/2 connection and edge cache.
 *
 * A tile's content at a z/x/y never changes, so the edge and the browser keep it for a year.
 */
export const TerrariumTileRoute = WorkerRoute.GET(
	"/terrain/terrarium/:z(\\d+)/:x(\\d+)/:y(\\d+).png",
	async ({ request, params, ctx }) => {
		const [z = -1, x = -1, y = -1] = parseTileCoordParams(params) ?? []

		if (z < 0 || z > TERRARIUM_MAX_ZOOM || x >= 2 ** z || y >= 2 ** z) {
			throw ResourceError.from(400, "Invalid terrarium tile coordinates")
		}

		const upstream = await fetch(`${TERRARIUM_ORIGIN}/${z}/${x}/${y}.png`)

		if (!upstream.ok) throw ResourceError.from(upstream.status, `Terrarium tile ${z}/${x}/${y} is unavailable`)

		const response = new Response(upstream.body, {
			headers: {
				"Content-Type": "image/png",
				"Cache-Control": "public, max-age=31536000, immutable",
			},
		})

		applyAccessControlAllowOrigin(request, response)

		cacheResponse(response, { request, ctx })

		return response
	}
)
