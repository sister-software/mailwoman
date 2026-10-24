import type { GeoFeature, PointLiteral, Coordinates2D } from "@mailwoman/spatial"

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

/**
 * Extracts the geographic information and coordinates from a Cloudflare request's metadata.
 *
 * @see {@linkcode cfRequestToGeoFeature} for converting the extracted geolocation into a GeoJSON feature.
 */
export function pluckCFRequestGeo(cf: RequestInitCfProperties): {
	properties: IncomingRequestCfPropertiesGeographicInformation
	coordinates: Coordinates2D
} {
	const properties = Object.fromEntries(
		CFGeolocationProperties.map((key) => [key, cf[key]])
	) as IncomingRequestCfPropertiesGeographicInformation

	const longitude = (properties.longitude ? Number.parseFloat(properties.longitude) : 0) || 0
	const latitude = (properties.latitude ? Number.parseFloat(properties.latitude) : 0) || 0

	return {
		properties,
		coordinates: [longitude, latitude],
	}
}

/**
 * Given a Cloudflare request's geographic information, returns a GeoJSON feature representing the location.
 *
 * @param cf The metadata provided by Cloudflare.
 * @see {@linkcode pluckCFRequestGeo} for the underlying extraction of geolocation data.
 */
export function cfRequestToGeoFeature(
	cf: RequestInitCfProperties
): GeoFeature<PointLiteral, IncomingRequestCfPropertiesGeographicInformation> {
	const { coordinates, properties } = pluckCFRequestGeo(cf)

	const feature: GeoFeature<PointLiteral, IncomingRequestCfPropertiesGeographicInformation> = {
		type: "Feature",
		geometry: {
			type: "Point",
			coordinates,
		},
		properties,
	}

	return feature
}
