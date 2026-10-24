/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The request's approximate location as a geocode bias point. Cloudflare places each request at the client's
 *   network location, at city precision when it has one. The Worker adds that point to a geocode request so a bare
 *   place name such as `Springfield` leans toward the one near the caller when the page sends no stronger signal.
 */

import { MAX_BIAS_POINTS } from "@mailwoman/api/input-limits"
import type { GeocodeBiasPoint } from "@mailwoman/api/operations/geocode/address"
import { stringifyJSON, tryParsingJSON } from "@mailwoman/core/json"

import { pluckCFRequestGeo } from "#cloudflare/geo"

/**
 * The weight of the request-location point.
 *
 * The page's viewport center weighs 1 and the granted device location 0.6.
 * A network location can sit a region away from the caller, so it pulls less than either.
 */
export const REQUEST_LOCATION_WEIGHT = 0.3

/**
 * The approximate location Cloudflare attached to `request`, or null when the
 * request has no coordinates, as outside Cloudflare.
 */
export function requestLocationOf(request: Request): GeocodeBiasPoint | null {
	const cf = (request as Request & { cf?: RequestInitCfProperties }).cf

	if (!cf) return null

	const { properties, coordinates } = pluckCFRequestGeo(cf)

	if (!properties.latitude || !properties.longitude) return null

	const [lon, lat] = coordinates

	return { lat, lon, weight: REQUEST_LOCATION_WEIGHT }
}

/**
 * The geocode body with `location` appended to its `bias`, as UTF-8 bytes.
 *
 * The body is returned unchanged when it is not a JSON object, when its `bias` is present
 * and not an array, or when the array already holds the most points a request may send.
 * The engine then validates it as sent.
 */
export function withRequestLocationBias(body: ArrayBuffer, location: GeocodeBiasPoint): ArrayBuffer {
	const parsed = tryParsingJSON(new TextDecoder().decode(body))

	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return body

	const request = parsed as { bias?: unknown }
	const bias = request.bias ?? []

	if (!Array.isArray(bias) || bias.length >= MAX_BIAS_POINTS) return body

	const encoded = new TextEncoder().encode(stringifyJSON({ ...request, bias: [...bias, location] }))

	return encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength) as ArrayBuffer
}
