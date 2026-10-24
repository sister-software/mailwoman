/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { cfRequestToGeoFeature } from "@mailwoman/api-worker/cloudflare/geo"
import { ResourceError } from "@mailwoman/core/errors"
import { prettyJSON } from "@mailwoman/core/json"
import type { Context } from "hono"

import type { TileWorkerHono } from "#caching"

const ONE_HOUR_SECONDS = 60 * 60

/**
 * Returns the caller's approximate location from Cloudflare's request geo headers,
 * so the map can open somewhere useful without asking for permission.
 *
 * Outside Cloudflare, as under a unit test, the request has no `cf` field and the route answers 424.
 */
export function serveGeolocation(c: Context<TileWorkerHono>): Response {
	const { cf } = c.req.raw

	if (!cf) throw ResourceError.from(424, "Cannot geolocate without Cloudflare data.")

	return new Response(prettyJSON(cfRequestToGeoFeature(cf as RequestInitCfProperties)), {
		headers: {
			"Content-Type": "application/json",
			"Cache-Control": `public, max-age=${ONE_HOUR_SECONDS}`,
		},
	})
}
