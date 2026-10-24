/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { cfRequestToGeoFeature } from "@mailwoman/api-worker/cloudflare/geo"
import { ResourceError } from "@mailwoman/core/errors"
import { prettyJSON } from "@mailwoman/core/json"

import { applyAccessControlAllowOrigin } from "#cors"
import { WorkerRoute } from "#routing"

/**
 * Returns the caller's approximate location from Cloudflare's request geo headers,
 * so the map can open somewhere useful without asking for permission.
 */
export const GeolocateRoute = WorkerRoute.GET("/geolocate", ({ request }) => {
	const { cf } = request

	if (!cf) throw ResourceError.from(424, "Cannot geolocate without Cloudflare data.")

	const response = new Response(prettyJSON(cfRequestToGeoFeature(cf)), {
		headers: {
			"Content-Type": "application/json",
			"Cache-Control": `public, max-age=${60 * 60}`,
		},
	})

	applyAccessControlAllowOrigin(request, response)

	return response
})
