/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The two API clients this layer reads through — the Environment Agency's spatial-data services, and
 *   the Office for National Statistics boundary service the coverage statement's "England" is realized
 *   from.
 *
 *   BOTH ARE API REQUESTS AND BOTH GO THROUGH {@linkcode APIClient}. Small bodies, repeated calls,
 *   third-party hosts — the pacing, bounded retry, response caching and `ResourceError` mapping are
 *   exactly what these need. The 367 MB geodatabase is NOT one of them: it is a file transfer, it streams
 *   to disk on raw `fetch`, and `download.ts` says so in place.
 *
 *   FRESHNESS CANNOT BE PROBED BY CONTENT LENGTH. The EA's download host answers `HEAD` with HTTP 405 and
 *   ignores `Range` — it returns 200 with the whole file — so a size probe starts a real 367 MB download.
 *   {@linkcode EAFloodClient.readCatalogueRecord} reads the ISO revision date out of the catalogue entry
 *   instead, which is the authority's own statement about what changed and the only cheap freshness signal
 *   that exists here. The EA's own dataset page cannot supply it: `environment.data.gov.uk` serves that
 *   page as a client-side application and returns only its shell to a fetch, so the catalogue is the
 *   primary source that is actually readable.
 */

import { APIClient, type APIClientConfig, type ClockLike } from "@mailwoman/core/api"
import { buildDiskStorage } from "@mailwoman/core/api/disk-storage"
import { parseJSONArray } from "@mailwoman/core/objects"
import { dataRootPath } from "@mailwoman/core/utils"

import { EA_FLOOD_DATASET_ID, EA_FLOOD_LAYER } from "#vocabulary"

// Re-exported so a caller branching on this client's failures needs exactly one import.
export { isTransientResourceError } from "@mailwoman/core/api"
export { ResourceError } from "@mailwoman/core/errors"

/**
 * The EA's spatial-data service root for the Flood Map for Planning product.
 */
export const EA_SPATIAL_BASE_URL = "https://environment.data.gov.uk/spatialdata/flood-map-for-planning-flood-zones"

/**
 * The dataset landing page, whose ISO metadata carries the revision date and the attribution string.
 */
export const EA_DATASET_BASE_URL = "https://environment.data.gov.uk/dataset"

/**
 * Minimum spacing between EA requests, in milliseconds.
 *
 * The EA publishes no rate limit for these services and its WFS `GetCapabilities` reports `<ows:Fees>NONE`, so this is
 * courtesy pacing rather than a published ceiling — stated as such rather than dressed up as a measured limit. Two
 * requests a second is far below anything a public OGC endpoint is provisioned for and costs a build nothing: the
 * acquisition path makes single-digit numbers of calls.
 */
export const EA_MIN_REQUEST_INTERVAL_MS = 500

/**
 * How long a cached EA metadata response stays fresh.
 *
 * Six hours, chosen against the product's cadence rather than a wall-clock intuition. The ISO
 * `MD_MaintenanceFrequencyCode` is `asNeeded` and the product description states an intent to publish quarterly, so the
 * revision date moves at most a handful of times a year. A shorter TTL buys nothing.
 */
const EA_CACHE_TTL_MS = 6 * 60 * 60 * 1000

export interface CreateFloodClientOptions {
	clock?: ClockLike
	cacheDirectory?: string
	minRequestIntervalMs?: number
}

/**
 * The data.gov.uk catalogue entry for the product — the readable primary source for its ISO reference dates, its
 * licence field, and the direct file URLs.
 */
export const EA_CATALOGUE_PACKAGE_ID = "104434b0-5263-4c90-9b1e-e43b1d57c750"

/**
 * The catalogue API the entry is read from.
 */
export const CATALOGUE_API_BASE_URL = "https://ckan.publishing.service.gov.uk/api/3/action"

/**
 * The licence value the catalogue entry must carry. A different value is a licence change, and a build that absorbed
 * one would ship an artifact under terms nobody checked.
 */
export const EA_EXPECTED_CATALOGUE_LICENCE = "Open Government Licence"

/**
 * What the catalogue says about the product.
 */
export interface FloodCatalogueRecord {
	/**
	 * The dataset's own identifier, which must equal {@link EA_FLOOD_DATASET_ID}.
	 */
	datasetID: string
	/**
	 * The ISO `revision` reference date — the product vintage, and the freshness signal.
	 */
	revisionDate: string
	publicationDate: string | null
	creationDate: string | null
	/**
	 * The licence the catalogue names.
	 */
	licence: string
	/**
	 * Direct file URLs by resource name.
	 */
	files: Record<string, string>
}

/**
 * Ordinates in a CRS84 bounding box: `minLon, minLat, maxLon, maxLat`. A shorter array is a 3D extent this reader does
 * not understand, not a 2D one with something missing.
 */
const BBOX_ORDINATES = 4

/**
 * A client for the EA's WFS / OGC API Features endpoints and the product's catalogue entry.
 */
export class EAFloodClient extends APIClient<APIClientConfig> {
	/**
	 * The catalogue entry: reference dates, licence, and the direct file URLs.
	 *
	 * The download URL is READ FROM HERE rather than assembled, because the EA's file service keys on an opaque
	 * `fileDataSetId` that has no relationship to the dataset id — a hard-coded URL survives a republish by pointing at a
	 * file that is no longer the product.
	 *
	 * @throws {Error} When the entry names a different dataset, carries no `revision` reference date, or names a licence
	 *   other than {@link EA_EXPECTED_CATALOGUE_LICENCE}.
	 */
	public async readCatalogueRecord(): Promise<FloodCatalogueRecord> {
		const { data } = await this.fetch<{
			success?: boolean
			result?: {
				extras?: Array<{ key: string; value: string }>
				resources?: Array<{ name?: string; url?: string }>
			}
		}>({
			method: "GET",
			url: `${CATALOGUE_API_BASE_URL}/package_show`,
			params: { id: EA_CATALOGUE_PACKAGE_ID },
		})

		const result = data.result

		if (!data.success || !result) {
			throw new Error(`flood client: the catalogue returned no record for ${EA_CATALOGUE_PACKAGE_ID}`)
		}

		const extras = new Map((result.extras ?? []).map((extra) => [extra.key, extra.value]))
		const datasetID = extras.get("guid") ?? ""

		if (datasetID !== EA_FLOOD_DATASET_ID) {
			throw new Error(
				`flood client: catalogue entry ${EA_CATALOGUE_PACKAGE_ID} names dataset ${JSON.stringify(datasetID)}, expected ${EA_FLOOD_DATASET_ID}`
			)
		}

		const dates = parseJSONArray<{ type: string; value: string }>(extras.get("dataset-reference-date"), "flood client")
		const revision = dates.find((date) => date.type === "revision")?.value

		if (!revision) {
			throw new Error(
				"flood client: the catalogue entry carries no `revision` reference date — the product vintage cannot be read, and guessing it would stamp an artifact with a version that means nothing"
			)
		}

		const licences = parseJSONArray<string>(extras.get("licence"), "flood client")

		if (!licences.includes(EA_EXPECTED_CATALOGUE_LICENCE)) {
			throw new Error(
				`flood client: the catalogue entry names licence ${JSON.stringify(licences)}, expected ${JSON.stringify(EA_EXPECTED_CATALOGUE_LICENCE)} — a licence change decides whether this layer may be redistributed at all`
			)
		}

		const files: Record<string, string> = {}

		for (const resource of result.resources ?? []) {
			if (resource.name && resource.url) {
				files[resource.name] = resource.url
			}
		}

		return {
			datasetID,
			revisionDate: revision,
			publicationDate: dates.find((date) => date.type === "publication")?.value ?? null,
			creationDate: dates.find((date) => date.type === "creation")?.value ?? null,
			licence: EA_EXPECTED_CATALOGUE_LICENCE,
			files,
		}
	}

	/**
	 * The feature count the WFS reports for the flood-zone layer — `resultType=hits`, which returns the count without a
	 * single geometry.
	 *
	 * This is the SECOND path in the build's two-path agreement check: the same authority, a different distribution
	 * channel. A geodatabase whose feature count disagrees with the live service is not a file this build should be
	 * writing into a sealed artifact.
	 */
	public async readFeatureCount(): Promise<number> {
		const { data } = await this.fetch<string>({
			method: "GET",
			url: `${EA_SPATIAL_BASE_URL}/wfs`,
			responseType: "text",
			params: {
				service: "WFS",
				version: "2.0.0",
				request: "GetFeature",
				typeNames: `dataset-${EA_FLOOD_DATASET_ID}:${EA_FLOOD_LAYER}`,
				resultType: "hits",
			},
		})

		const matched = /numberMatched="(\d+)"/u.exec(data)

		if (!matched) {
			throw new Error("flood client: the WFS hits response carried no numberMatched attribute")
		}

		return Number(matched[1])
	}

	/**
	 * The extent the OGC API Features collection declares for the layer, in CRS84 order.
	 *
	 * Read at build time rather than trusted from the constant in `vocabulary.ts`: the constant is what the ingest
	 * asserts against offline, and this is the live value it is reconciled with when the network is available.
	 */
	public async readDeclaredBBox(): Promise<[number, number, number, number]> {
		const { data } = await this.fetch<{
			extent?: { spatial?: { bbox?: number[][] } }
		}>({
			method: "GET",
			url: `${EA_SPATIAL_BASE_URL}/ogc/features/v1/collections/${EA_FLOOD_LAYER}`,
			params: { f: "application/json" },
		})

		const bbox = data.extent?.spatial?.bbox?.[0]

		if (!bbox || bbox.length < BBOX_ORDINATES) {
			throw new TypeError("flood client: the OGC collection carried no spatial extent")
		}

		return [bbox[0]!, bbox[1]!, bbox[2]!, bbox[3]!]
	}
}

/**
 * Build an {@link EAFloodClient} with the disk cache and pacing this package's acquisition path expects.
 */
export function createEAFloodClient(options: CreateFloodClientOptions = {}): EAFloodClient {
	return new EAFloodClient({
		displayName: "EAFlood",
		minRequestIntervalMs: options.minRequestIntervalMs ?? EA_MIN_REQUEST_INTERVAL_MS,
		retry: true,
		...(options.clock ? { clock: options.clock } : {}),
		caching: {
			ttl: EA_CACHE_TTL_MS,
			storage: buildDiskStorage({
				directory: options.cacheDirectory ?? String(dataRootPath("flood", "cache", "http")),
			}),
		},
	})
}

/**
 * The ONS Open Geography boundary service — where "England" comes from.
 *
 * The EA states that its mapping "covers all of England" and does not publish where England is; the national
 * statistical authority does. Realizing the coverage statement therefore takes a second authority's artifact, and which
 * one it was is written into `flood_map_extent` rather than left implicit.
 */
export const ONS_BOUNDARY_BASE_URL =
	"https://services1.arcgis.com/ESMARspQHYMw9BZ9/arcgis/rest/services/Countries_December_2025_Boundaries_UK_BGC/FeatureServer/0"

/**
 * The ONS product the default boundary comes from — generalised (20 m) and clipped to the coastline.
 *
 * Generalised rather than full-resolution on purpose: the interior test is conservative by construction, so a cell near
 * the border is dropped rather than mis-claimed, and 20 m of boundary generalisation is invisible against a coverage
 * cell whose edge is kilometres long. The full-resolution product would multiply the download for no change in the cell
 * set.
 */
export const ONS_BOUNDARY_PRODUCT = "Countries (December 2025) Boundaries UK BGC"

/**
 * The attribution ONS Open Geography requires of a re-user of its boundary products.
 */
export const ONS_BOUNDARY_ATTRIBUTION =
	"Contains National Statistics data © Crown copyright and database right 2025. " +
	"Contains OS data © Crown copyright and database right 2025."

/**
 * ONS boundary data is published under the Open Government Licence, the same licence as the flood product.
 */
export const ONS_BOUNDARY_LICENSE = "OGL-UK-3.0"

/**
 * A client for the ONS boundary service.
 */
export class ONSBoundaryClient extends APIClient<APIClientConfig> {
	/**
	 * One country's outline as a GeoJSON geometry, in WGS84.
	 *
	 * @throws {Error} When the service returns no feature for `countryName`, or more than one. A country matched twice is
	 *   a product whose name column changed meaning, and picking the first would silently choose an outline.
	 */
	public async readCountryGeometry(countryName: string): Promise<{
		geometry: { type: string; coordinates: unknown }
		code: string
		name: string
	}> {
		const { data } = await this.fetch<{
			features?: Array<{ properties?: Record<string, string>; geometry?: { type: string; coordinates: unknown } }>
		}>({
			method: "GET",
			url: `${ONS_BOUNDARY_BASE_URL}/query`,
			params: {
				where: `CTRY25NM='${countryName}'`,
				outFields: "CTRY25CD,CTRY25NM",
				returnGeometry: "true",
				outSR: "4326",
				f: "geojson",
			},
		})

		const features = data.features ?? []

		if (features.length !== 1) {
			throw new Error(
				`flood client: the ONS boundary service returned ${features.length} features for ${JSON.stringify(countryName)}, expected exactly 1`
			)
		}

		const feature = features[0]!

		if (!feature.geometry) {
			throw new Error(`flood client: the ONS boundary feature for ${JSON.stringify(countryName)} carries no geometry`)
		}

		return {
			geometry: feature.geometry,
			code: feature.properties?.CTRY25CD ?? "",
			name: feature.properties?.CTRY25NM ?? countryName,
		}
	}
}

/**
 * Build an {@link ONSBoundaryClient}. Cached for a year: a December-2025 boundary product does not change, and a new
 * vintage is a new service name rather than new content at this one.
 */
export function createONSBoundaryClient(options: CreateFloodClientOptions = {}): ONSBoundaryClient {
	return new ONSBoundaryClient({
		displayName: "ONSBoundary",
		minRequestIntervalMs: options.minRequestIntervalMs ?? EA_MIN_REQUEST_INTERVAL_MS,
		retry: true,
		...(options.clock ? { clock: options.clock } : {}),
		caching: {
			ttl: 365 * 24 * 60 * 60 * 1000,
			storage: buildDiskStorage({
				directory: options.cacheDirectory ?? String(dataRootPath("flood", "cache", "http")),
			}),
		},
	})
}
