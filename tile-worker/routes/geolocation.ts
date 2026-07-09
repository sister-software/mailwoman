/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { ResourceError } from "@mailwoman/core/errors"
import type { GeoFeature, PointLiteral } from "@mailwoman/spatial"

import { applyAccessControlAllowOrigin } from "../cors.ts"
import { WorkerRoute } from "../routing.ts"

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
	const { cf } = request

	if (!cf) throw ResourceError.from(424, "Cannot geolocate without Cloudflare data.")

	const geolocation = Object.fromEntries(
		CFGeolocationProperties.map((key) => [key, cf[key]])
	) as IncomingRequestCfPropertiesGeographicInformation

	const latitude = (geolocation.latitude ? parseFloat(geolocation.latitude) : 0) || 0
	const longitude = (geolocation.longitude ? parseFloat(geolocation.longitude) : 0) || 0

	const feature: GeoFeature<PointLiteral, IncomingRequestCfPropertiesGeographicInformation> = {
		type: "Feature",
		geometry: {
			type: "Point",
			coordinates: [longitude, latitude],
		},
		properties: geolocation,
	}

	const response = new Response(JSON.stringify(feature, null, "\t"), {
		headers: {
			"Content-Type": "application/json",
			"Cache-Control": `public, max-age=${60 * 60}`,
		},
	})

	applyAccessControlAllowOrigin(request, response)

	return response
})
