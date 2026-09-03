/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The Department's ArcGIS item, its feature service and the Hub download job, read through
 *   {@linkcode APIClient}.
 *
 *   THESE ARE API REQUESTS AND THEY GO THROUGH `APIClient`. Small bodies, repeated calls, a third-party
 *   host — the pacing, bounded retry, response caching and `ResourceError` mapping are exactly what they
 *   need. The 247 MB bulk export is NOT one of them: it is a file transfer, it streams to disk on raw
 *   `fetch`, and `download.ts` says so in place.
 *
 *   FOUR MEASURED CLIENT BEHAVIORS ARE ENCODED HERE RATHER THAN WRITTEN DOWN SOMEWHERE ELSE.
 *
 *   1. THE HUB DOWNLOAD JOB ANSWERS WITH A `resultUrl` THAT 302s. `…/api/download/v1/items/<id>/geojson?
 *      redirect=false&layers=0` returns `{"status":"Completed","resultUrl":…}` in 249 bytes; the result URL
 *      itself redirects, so the transfer needs `redirect: "follow"`. A client that took the first response as
 *      the file writes a redirect page to disk and reports a successful download.
 *   2. THE BULK EXPORT IS EPSG:2157 UNDER A `crs` MEMBER RFC 7946 REMOVED. The file's own header carries
 *      `"crs":{"type":"name","properties":{"name":"EPSG:2157"}}` and its coordinates are Irish Transverse
 *      Mercator metres. A strict RFC 7946 reader ignores the member and places Ireland at latitude 735,435;
 *      GDAL honours it, which is why `sdk/ingest.ts` reads the archive through ogr2ogr and asserts the
 *      reprojected result lands inside the Department's own declared extent.
 *   3. THE PUBLISHER'S OWN AREA STATISTIC IS NOT IN THE ARCHIVE. `Shape__Area` is a service field and the
 *      GeoJSON export drops it, so the area cross-check has to come from {@linkcode readShapeAreaSum} — which
 *      makes it a genuine two-path check rather than the archive agreeing with itself. Measured:
 *      5,444,492,956.40 m² over 85,330 features.
 *   4. `GZT_LINK` POINTS AT A HOST WITH NO DNS RECORD. All 85,330 rows link their generic type's definition to
 *      `viewer.myplan.ie`, which has no A or AAAA record, and three candidate replacements on the live host
 *      answer HTTP 404. So `zoning_vocabulary.definition_url` cannot be populated from it and is left NULL
 *      rather than filled with a plausible one.
 */

import { APIClient, type APIClientConfig, assertNoArcGISError } from "@mailwoman/core/api"
import { createPacedCachedClient, type CreatePacedCachedClientOptions } from "@mailwoman/core/api/paced-client"
import { htmlToText } from "@mailwoman/core/html/text"

import { GZT_ATTRIBUTION, GZT_ITEM_ID, GZT_SERVICE_URL, GZT_SOURCE_EPSG } from "#vocabulary"

// Re-exported so a caller branching on this client's failures needs exactly one import.
export { isTransientResourceError } from "@mailwoman/core/api"
export { ResourceError } from "@mailwoman/core/errors"

/**
 * The ArcGIS Online sharing API, where the item's licence and attribution fields are readable.
 */
export const ARCGIS_ITEM_API_BASE_URL = "https://www.arcgis.com/sharing/rest/content/items"

/**
 * The Hub download API, which is how the whole layer is exported in one file.
 */
export const HUB_DOWNLOAD_API_BASE_URL = "https://hub.arcgis.com/api/download/v1/items"

/**
 * Minimum spacing between requests to the Department's hosts, in milliseconds.
 *
 * The Department publishes no rate limit for this service, so this is courtesy pacing rather than a published ceiling —
 * stated as such rather than dressed up as a measured limit. Two requests a second is far below anything a hosted
 * ArcGIS feature service is provisioned for and costs a build nothing: the acquisition path makes single-digit numbers
 * of calls and the verification a few dozen.
 */
export const GZT_MIN_REQUEST_INTERVAL_MS = 500

/**
 * How long a cached metadata response stays fresh.
 *
 * Six hours, chosen against the product's own cadence rather than a wall-clock intuition. The Department publishes no
 * maintenance-frequency statement at all; what is observable is that the item's `modified` date and the data's latest
 * `UPLOAD_DATE` move a handful of times a year, so a shorter TTL buys nothing.
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
	 * The item's `modified` timestamp as an ISO date — the product vintage, and the freshness signal.
	 */
	modifiedDate: string
	/**
	 * `accessInformation`, verbatim: the credit line the Department asks for.
	 */
	accessInformation: string
	/**
	 * `licenseInfo`, verbatim, with its markup stripped. Read rather than trusted from the constant, so a change in the
	 * terms is visible at build time.
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
				`zoning client: the item endpoint answered for ${JSON.stringify(data.id)}, expected ${GZT_ITEM_ID}`
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
			throw new TypeError(`zoning client: the item's extent is not a 2D bounding box (${JSON.stringify(extent)})`)
		}

		return {
			itemID: data.id,
			title: data.title ?? "",
			modifiedDate: new Date(data.modified).toISOString().slice(0, 10),
			accessInformation: data.accessInformation ?? "",
			licenseInfo: htmlToText(data.licenseInfo ?? ""),
			declaredBBox: bbox,
		}
	}

	/**
	 * The feature count the service reports, and the EPSG code it declares.
	 *
	 * The SECOND path in the build's agreement check: the same authority, a different distribution channel. An archive
	 * whose feature count disagrees with the live service is not a file this build should be writing into a sealed
	 * artifact.
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
	 * The sum of the Department's own `Shape__Area` column, in square metres.
	 *
	 * THE ONE NUMBER THAT SETTLES THE HOLE QUESTION, and it has to come from the service because the bulk export drops
	 * the column. Read with the holes the rings total 5,444.5 km²; read without them, 5,666.6 km². The difference is 4.1%
	 * of area and, far more importantly, a ray cast that answers "inside" for every location a plan carved out.
	 */
	public async readShapeAreaSum(): Promise<number> {
		const { data } = await this.fetch<{ features?: Array<{ attributes?: Record<string, number> }> }>({
			method: "GET",
			url: `${GZT_SERVICE_URL}/query`,
			params: {
				where: "1=1",
				outStatistics: JSON.stringify([
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
	 * Ask the Hub for a bulk GeoJSON export and return the URL it answers with.
	 *
	 * `redirect=false` asks for the job record rather than a redirect, so this call reads a small JSON body. The URL it
	 * returns is the one that 302s — see {@link downloadZoningExport}.
	 *
	 * @throws {Error} When the job is not `Completed`, or names no result URL. A partial job that answered with a status
	 *   and no URL would otherwise present as an empty download.
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
				`zoning client: the Hub download job answered status ${JSON.stringify(data.status)} with ${
					data.resultUrl ? "a" : "no"
				} result URL${data.message ? ` (${data.message})` : ""}`
			)
		}

		return data.resultUrl
	}

	/**
	 * The features the service publishes near a point — the verification's second path.
	 *
	 * `outSR=4326` on the query path, because the service answers in Irish Transverse Mercator otherwise and the
	 * comparison is against coordinates this package reprojected itself. The service answers a bounding box rather than a
	 * point, so the containment decision is made against the returned rings by the caller.
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
				geometry: JSON.stringify({
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
 * Refuse an attribution the published item no longer matches.
 *
 * READ AT BUILD TIME RATHER THAN TRUSTED FROM THE CONSTANT. The constant is what the artifact is stamped with offline;
 * this is the live value it is reconciled with when the network is available. The check is on the DEPARTMENT'S CREDIT
 * LINE and on the Tailte Éireann clause separately, because they are two different statements and the second is the one
 * that holds this layer at `build-local`: an item that dropped it would be a licence change worth hearing about, and an
 * item that dropped only the credit line would be a different one.
 *
 * @throws {Error} When either half of {@link GZT_ATTRIBUTION} is no longer in the item's own fields.
 */
export function assertAttributionUnchanged(record: Pick<ZoningItemRecord, "accessInformation" | "licenseInfo">): void {
	if (!GZT_ATTRIBUTION.includes(record.accessInformation.trim()) || !record.accessInformation.trim()) {
		throw new Error(
			`zoning client: the item's accessInformation reads ${JSON.stringify(record.accessInformation)}, and this build ships ` +
				`${JSON.stringify(GZT_ATTRIBUTION)} — the credit line is what a re-user has to publish, so a change in it is a change in the terms`
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
