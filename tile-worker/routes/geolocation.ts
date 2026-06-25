/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { ResourceError } from "@mailwoman/core/errors"
import { applyAccessControlAllowOrigin } from "../cors.js"
import { WorkerRoute } from "../routing.js"

const CFGeolocationProperties = [
	"country",
	"isEUCountry",
	"continent",
	"city",
	"postalCode",
	"latitude",
	"longitude",
	"timezone",
	"region",
	"regionCode",
	"metroCode",
] as const satisfies Array<keyof IncomingRequestCfPropertiesGeographicInformation>

export const GeolocateRoute = WorkerRoute.GET("/geolocate", ({ request }) => {
	if (!request.cf) throw ResourceError.from(424, "Cannot geolocate without Cloudflare data.")

	const cf = request.cf

	const geolocation = Object.fromEntries(
		CFGeolocationProperties.map((key) => [key, cf[key]])
	) as IncomingRequestCfPropertiesGeographicInformation

	const response = new Response(JSON.stringify(geolocation, null, "\t"), {
		headers: {
			"Content-Type": "application/json",
			"Cache-Control": `public, max-age=${60 * 60}`,
		},
	})

	applyAccessControlAllowOrigin(request, response)

	return response
})
