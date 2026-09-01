/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   A Cloudflare Worker that serves PMTiles archives.
 */

import type { ExportedHandler } from "@cloudflare/workers-types"
import { ResourceError } from "@mailwoman/core/errors"
import { prettyJSON } from "@mailwoman/core/objects"

import { applyAccessControlAllowOrigin } from "#cors"
import { DatabaseRetrieveRoute } from "#routes/db"
import { GeolocateRoute } from "#routes/geolocation"
import { HealthCheckRoute, HomeRoute } from "#routes/healthcheck"
import { BroadbandProviderTileMetadataRoute, BroadbandProviderTileRoute } from "#routes/provider"
import { TIGERTileMetadataRoute, TIGERTileRoute } from "#routes/tiger"
import { TileMetadataRoute, TileRoute } from "#routes/tile"
import { delegateRequest, type RouteContext, type TileWorkerEnv } from "#routing"

const handler: ExportedHandler<TileWorkerEnv> = {
	fetch: (request, env, ctx) => {
		const url = new URL(request.url)

		const routeContext: RouteContext = { request, url, env, ctx, params: {} }

		return delegateRequest(routeContext, [
			DatabaseRetrieveRoute,
			TIGERTileMetadataRoute,
			TIGERTileRoute,
			TileMetadataRoute,
			TileRoute,
			BroadbandProviderTileRoute,
			BroadbandProviderTileMetadataRoute,
			GeolocateRoute,
			HomeRoute,
			HealthCheckRoute,
		]).catch((error) => {
			if (error instanceof ResourceError) {
				const response = new Response(prettyJSON(error), {
					status: error.status,
					headers: {
						"Content-Type": "application/json",
					},
				})

				applyAccessControlAllowOrigin(request, response)

				return response
			}

			console.error(error)

			const response = new Response("Nexus Internal Server Error", { status: 500 })
			applyAccessControlAllowOrigin(request, response)

			return response
		})
	},
}

export default handler
