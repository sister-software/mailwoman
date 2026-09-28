/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * The Department's ArcGIS item, its feature service and the Hub download job, read through {@linkcode APIClient}; the bulk export streams to disk on raw `fetch` instead.
 */

import { APIClient, type APIClientConfig, assertNoArcGISError } from "@mailwoman/core/api"
import { createPacedCachedClient, type CreatePacedCachedClientOptions } from "@mailwoman/core/api/paced-client"
import { htmlToText } from "@mailwoman/core/html/text"
import { stringifyJSON } from "@mailwoman/core/json"
import { isoDate } from "@mailwoman/core/utils"

import { GZT_ATTRIBUTION, GZT_ITEM_ID, GZT_SERVICE_URL, GZT_SOURCE_EPSG } from "#vocabulary"

/**
 * The ArcGIS Online sharing API.
 *
 * The item's licence and attribution fields are available there.
 */
export const ARCGIS_ITEM_API_BASE_URL = "https://www.arcgis.com/sharing/rest/content/items"

/**
 * The Hub download API exports the whole layer as one file.
 */
export const HUB_DOWNLOAD_API_BASE_URL = "https://hub.arcgis.com/api/download/v1/items"

/**
 * Minimum spacing between requests to the Department's hosts, courtesy pacing
 * because the Department publishes no rate limit for this service.
 */
export const GZT_MIN_REQUEST_INTERVAL_MS = 500

/**
 * How long a cached metadata response stays fresh, six hours because the item's `modified` date
 * and the data's latest `UPLOAD_DATE` move only a handful of times a year.
 */
const GZT_CACHE_TTL_MS = 6 * 60 * 60 * 1000

export type CreateZoningClientOptions = CreatePacedCachedClientOptions

/**
 * What the item says about the product.
 */
export interface ZoningItemRecord {
	itemID: string
	title: string
	/**
	 * The item's `modified` timestamp as an ISO date.
	 * It records product vintage and signals freshness.
	 */
	modifiedDate: string
	/**
	 * `accessInformation`, verbatim: the credit line the Department asks for.
	 */
	accessInformation: string
	/**
	 * `licenseInfo`, verbatim with its markup stripped, read rather than trusted from
	 * the constant so a change in the terms is visible at build time.
	 */
	licenseInfo: string
	/**
	 * The extent the item declares, in CRS84 order.
	 */
	declaredBBox: [number, number, number, number]
}

/**
 * Ordinates in a CRS84 bounding box: `minLon, minLat, maxLon, maxLat`.
 */
const BBOX_ORDINATES = 4

/**
 * A client for the Department's item, feature service and Hub download job.
 */
export class GZTClient extends APIClient<APIClientConfig> {
	/**
	 * The item record: its vintage, its credit line, its licence text and its declared extent.
	 *
	 * @throws {Error} When the item is missing, or declares no extent.
	 */
	public async readItemRecord(): Promise<ZoningItemRecord> {
		const { data } = await this.fetch<{
			id?: string
			title?: string
			modified?: number
			accessInformation?: string | null
			licenseInfo?: string | null
			extent?: number[][]
		}>({
			method: "GET",
			url: `${ARCGIS_ITEM_API_BASE_URL}/${GZT_ITEM_ID}`,
			params: { f: "json" },
		})

		assertNoArcGISError(data, "zoning client")

		if (data.id !== GZT_ITEM_ID) {
			throw new Error(
				`zoning client: the item endpoint answered for ${stringifyJSON(data.id)}, expected ${GZT_ITEM_ID}`
			)
		}

		if (typeof data.modified !== "number") {
			throw new TypeError(
				"zoning client: the item carries no `modified` timestamp — the product vintage cannot be read, and guessing it would stamp an artifact with a version that means nothing"
			)
		}

		const extent = data.extent

		if (!extent || extent.length < 2 || !extent[0] || !extent[1]) {
			throw new TypeError("zoning client: the item declares no extent")
		}

		const bbox: [number, number, number, number] = [extent[0][0]!, extent[0][1]!, extent[1][0]!, extent[1][1]!]

		if (bbox.some((ordinate) => !Number.isFinite(ordinate)) || bbox.length !== BBOX_ORDINATES) {
			throw new TypeError(`zoning client: the item's extent is not a 2D bounding box (${stringifyJSON(extent)})`)
		}

		return {
			itemID: data.id,
			title: data.title ?? "",
			modifiedDate: isoDate(new Date(data.modified)),
			accessInformation: data.accessInformation ?? "",
			licenseInfo: htmlToText(data.licenseInfo ?? ""),
			declaredBBox: bbox,
		}
	}

	/**
	 * The feature count and EPSG code the service reports, the second path in the build's agreement check.
	 */
	public async readServiceIdentity(): Promise<{ featureCount: number; epsg: number; maxRecordCount: number }> {
		const { data } = await this.fetch<{
			extent?: { spatialReference?: { wkid?: number; latestWkid?: number } }
			maxRecordCount?: number
		}>({ method: "GET", url: GZT_SERVICE_URL, params: { f: "json" } })

		assertNoArcGISError(data, "zoning client")

		const epsg = data.extent?.spatialReference?.latestWkid ?? data.extent?.spatialReference?.wkid

		if (epsg !== GZT_SOURCE_EPSG) {
			throw new Error(
				`zoning client: the service declares EPSG:${epsg}, expected EPSG:${GZT_SOURCE_EPSG} — the source's projection changed, which is a product change rather than a variation to absorb`
			)
		}

		const { data: counted } = await this.fetch<{ count?: number }>({
			method: "GET",
			url: `${GZT_SERVICE_URL}/query`,
			params: { where: "1=1", returnCountOnly: "true", f: "json" },
		})

		assertNoArcGISError(counted, "zoning client")

		if (typeof counted.count !== "number") {
			throw new TypeError("zoning client: the service returned no feature count")
		}

		return { featureCount: counted.count, epsg, maxRecordCount: data.maxRecordCount ?? 0 }
	}

	/**
	 * The sum of the Department's `Shape__Area` column in square metres.
	 *
	 * The service must provide this value because the bulk export omits the column.
	 */
	public async readShapeAreaSum(): Promise<number> {
		const { data } = await this.fetch<{ features?: Array<{ attributes?: Record<string, number> }> }>({
			method: "GET",
			url: `${GZT_SERVICE_URL}/query`,
			params: {
				where: "1=1",
				outStatistics: stringifyJSON([
					{ statisticType: "sum", onStatisticField: "Shape__Area", outStatisticFieldName: "area_sum" },
				]),
				f: "json",
			},
		})

		assertNoArcGISError(data, "zoning client")

		const sum = data.features?.[0]?.attributes?.area_sum

		if (typeof sum !== "number" || !Number.isFinite(sum)) {
			throw new TypeError(
				"zoning client: the service returned no Shape__Area sum — without the publisher's own figure the hole-orientation check has nothing to compare against, and reading every ring as an exterior is silent"
			)
		}

		return sum
	}

	/**
	 * Ask the Hub for a bulk GeoJSON export and return the result URL, a 302 that the caller has to follow.
	 *
	 * @throws {Error} When the job is not `Completed`, or names no result URL.
	 * A partial job that answered with a status and no URL would otherwise present as an empty download.
	 */
	public async readExportURL(): Promise<string> {
		const { data } = await this.fetch<{ status?: string; resultUrl?: string; message?: string }>({
			method: "GET",
			url: `${HUB_DOWNLOAD_API_BASE_URL}/${GZT_ITEM_ID}/geojson`,
			params: { redirect: "false", layers: "0" },
		})

		assertNoArcGISError(data, "zoning client")

		if (data.status !== "Completed" || !data.resultUrl) {
			throw new Error(
				`zoning client: the Hub download job answered status ${stringifyJSON(data.status)} with ${
					data.resultUrl ? "a" : "no"
				} result URL${data.message ? ` (${data.message})` : ""}`
			)
		}

		return data.resultUrl
	}

	/**
	 * The features the service publishes near a point, queried with `outSR=4326`
	 * because it answers in Irish Transverse Mercator otherwise.
	 */
	public async readFeaturesNear(
		latitude: number,
		longitude: number,
		halfWidthDegrees: number
	): Promise<Array<{ properties?: Record<string, unknown>; geometry?: { type: string; coordinates: unknown } }>> {
		const { data } = await this.fetch<{
			features?: Array<{ properties?: Record<string, unknown>; geometry?: { type: string; coordinates: unknown } }>
		}>({
			method: "GET",
			url: `${GZT_SERVICE_URL}/query`,
			params: {
				geometry: stringifyJSON({
					xmin: longitude - halfWidthDegrees,
					ymin: latitude - halfWidthDegrees,
					xmax: longitude + halfWidthDegrees,
					ymax: latitude + halfWidthDegrees,
					spatialReference: { wkid: 4326 },
				}),
				geometryType: "esriGeometryEnvelope",
				inSR: "4326",
				outSR: "4326",
				spatialRel: "esriSpatialRelIntersects",
				outFields: "OBJECTID,ZONE_ORIG,ZONE_GZT,LA_CODE",
				returnGeometry: "true",
				f: "geojson",
			},
		})

		assertNoArcGISError(data, "zoning client")

		return data.features ?? []
	}
}

/**
 * Refuse an attribution the published item no longer matches, checking the Department's
 * credit line and the Tailte Éireann clause separately.
 *
 * @throws {Error} When either half of {@link GZT_ATTRIBUTION} is no longer in the item's own fields.
 */
export function assertAttributionUnchanged(record: Pick<ZoningItemRecord, "accessInformation" | "licenseInfo">): void {
	if (!GZT_ATTRIBUTION.includes(record.accessInformation.trim()) || !record.accessInformation.trim()) {
		throw new Error(
			`zoning client: the item's accessInformation reads ${stringifyJSON(record.accessInformation)}, and this build ships ` +
				`${stringifyJSON(GZT_ATTRIBUTION)} — the credit line is what a re-user has to publish, so a change in it is a change in the terms`
		)
	}

	if (!record.licenseInfo.includes("Tailte Éireann")) {
		throw new Error(
			"zoning client: the item's licenseInfo no longer names Tailte Éireann as a licensor. That clause is the reason " +
				"this layer is built locally rather than shipped, so its disappearance is a licence change to read rather than absorb"
		)
	}
}

/**
 * Build a {@link GZTClient} with the disk cache and pacing this package's acquisition path expects.
 */
export function createGZTClient(options: CreateZoningClientOptions = {}): GZTClient {
	return createPacedCachedClient(
		GZTClient,
		{
			displayName: "GZT",
			minRequestIntervalMs: GZT_MIN_REQUEST_INTERVAL_MS,
			cacheTTLMs: GZT_CACHE_TTL_MS,
			cacheDirectory: ["zoning", "cache", "http"],
		},
		options
	)
}
