/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { APIClient, pluckResponseData } from "@mailwoman/core/api"
import { ResourceError } from "@mailwoman/core/errors"
import type { PolygonLiteral } from "@mailwoman/spatial/geometries/polygon"

import { polygonToOSMFilter, type OSMOverpassElement, type OSMOverpassResponseBody } from "#overpass/nodes"

const overpassClient = new APIClient({ displayName: "overpass", retry: true })

export function fetchOSMElementViaOverpassAPI(input: PolygonLiteral): Promise<OSMOverpassElement[]> {
	const filter = polygonToOSMFilter(input)

	const url = new URL("http://overpass-api.de/api/interpreter")
	url.searchParams.set("data", `[out:json];(node['addr:housenumber'](${filter}););out body;>;out skel qt;`)

	// Overpass is a free shared endpoint that answers a throttle with 429 + `Retry-After`. `retry: true` is what
	// reads that header, which is the server stating its own limit rather than this file guessing one. `ResourceError`
	// now arrives from the client instead of being assembled here.
	return overpassClient
		.fetch<OSMOverpassResponseBody>({ url: url.toString() })
		.then(pluckResponseData)
		.then((body) => body.elements)
		.catch((error) => {
			throw ResourceError.wrap(error, "osm", "overpass-api", "fetch")
		})
}
