/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   OGC service reads the layer products share: an API Features bbox probe, a collection's declared extent,
 *   and a WFS `resultType=hits` feature count — the second distribution channel every two-path agreement
 *   check re-asks.
 */

import type { APIClient } from "#api/APIClient"

/**
 * Ordinates in a CRS84 bounding box: `minLon, minLat, maxLon, maxLat`. A shorter array is a 3D extent this reader does
 * not understand, not a 2D one with something missing.
 */
const BBOX_ORDINATES = 4

export interface CreateOGCFeaturesBBoxReaderOptions {
	client: Pick<APIClient, "fetch">
	/**
	 * The collection root, e.g. `…/ogc/features/v1/collections/<layer>`.
	 */
	collectionURL: string
	/**
	 * Half-width of the bbox the service is asked for, in degrees.
	 */
	halfWidthDegrees: number
	/**
	 * Features per request — a ceiling rather than a page size when the probe bbox is metres wide.
	 */
	limit: number
}

/**
 * A reader answering an OGC API Features bbox query around a point.
 *
 * The service answers a BBOX, not a point, so this returns what it published nearby and the containment decision
 * belongs to the caller, against the returned rings — comparing a verdict against a bare "the service returned
 * something here" would pass on any polygon within the probe's width.
 */
export function createOGCFeaturesBBoxReader<Feature>(
	options: CreateOGCFeaturesBBoxReaderOptions
): (latitude: number, longitude: number) => Promise<Feature[]> {
	return async (latitude, longitude) => {
		const { data } = await options.client.fetch<{ features?: Feature[] }>({
			method: "GET",
			url: `${options.collectionURL}/items`,
			params: {
				bbox: [
					longitude - options.halfWidthDegrees,
					latitude - options.halfWidthDegrees,
					longitude + options.halfWidthDegrees,
					latitude + options.halfWidthDegrees,
				].join(","),
				limit: options.limit,
				f: "application/json",
			},
		})

		return data.features ?? []
	}
}

/**
 * The extent an OGC API Features collection declares, in CRS84 order.
 *
 * @param options.subject Names the collection in the refusal, where the caller reads more than one.
 */
export async function readOGCCollectionBBox(
	client: Pick<APIClient, "fetch">,
	options: { collectionURL: string; context: string; subject?: string }
): Promise<[number, number, number, number]> {
	const { data } = await client.fetch<{
		extent?: { spatial?: { bbox?: number[][] } }
	}>({
		method: "GET",
		url: options.collectionURL,
		params: { f: "application/json" },
	})

	const bbox = data.extent?.spatial?.bbox?.[0]

	if (!bbox || bbox.length < BBOX_ORDINATES) {
		throw new TypeError(
			`${options.context}: the OGC collection${options.subject === undefined ? "" : ` ${options.subject}`} carried no spatial extent`
		)
	}

	return [bbox[0]!, bbox[1]!, bbox[2]!, bbox[3]!]
}

/**
 * The feature count a WFS reports for one type — `resultType=hits`, which returns the count without a single geometry.
 *
 * @param options.subject Names the layer in the refusal, where the caller reads more than one.
 */
export async function readWFSFeatureCount(
	client: Pick<APIClient, "fetch">,
	options: { wfsURL: string; typeNames: string; context: string; subject?: string }
): Promise<number> {
	const { data } = await client.fetch<string>({
		method: "GET",
		url: options.wfsURL,
		responseType: "text",
		params: {
			service: "WFS",
			version: "2.0.0",
			request: "GetFeature",
			typeNames: options.typeNames,
			resultType: "hits",
		},
	})

	const matched = /numberMatched="(?<count>\d+)"/u.exec(data)

	if (!matched?.groups?.count) {
		throw new Error(
			`${options.context}: the WFS hits response${options.subject === undefined ? "" : ` for ${options.subject}`} carried no numberMatched attribute`
		)
	}

	return Number(matched.groups.count)
}
