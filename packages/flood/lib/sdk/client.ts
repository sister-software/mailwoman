/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Defines API clients for the Environment Agency flood services and the ONS boundary service.
 *
 *   The geodatabase download bypasses these clients and streams to disk in `download.ts`.
 *
 *   Freshness comes from the catalogue's revision date. The EA download host rejects `HEAD` with 405 and
 *   ignores `Range`, so any size probe downloads the whole file. The EA dataset page renders client-side,
 *   so a fetch returns no metadata.
 */

import {
	APIClient,
	readCKANPackageRecord,
	readOGCCollectionBBox,
	readWFSFeatureCount,
	type APIClientConfig,
	type CKANPackageRecord,
} from "@mailwoman/core/api"
import { createPacedCachedClient, type CreatePacedCachedClientOptions } from "@mailwoman/core/api/paced-client"
import { stringifyJSON } from "@mailwoman/core/json"

import { EA_FLOOD_DATASET_ID, EA_FLOOD_LAYER } from "#vocabulary"

/**
 * Service root for the EA Flood Map for Planning product.
 */
export const EA_SPATIAL_BASE_URL = "https://environment.data.gov.uk/spatialdata/flood-map-for-planning-flood-zones"

/**
 * Base URL of the EA dataset pages.
 */
export const EA_DATASET_BASE_URL = "https://environment.data.gov.uk/dataset"

/**
 * Minimum spacing between EA requests, in milliseconds.
 *
 * The EA publishes no rate limit, so this value is a courtesy.
 * A build makes only a few calls.
 */
export const EA_MIN_REQUEST_INTERVAL_MS = 500

/**
 * Cache lifetime for EA metadata responses, six hours.
 *
 * The EA updates the product as needed and aims for quarterly releases.
 */
const EA_CACHE_TTL_MS = 6 * 60 * 60 * 1000

/**
 * Options for {@link createEAFloodClient} and {@link createONSBoundaryClient}.
 */
export type CreateFloodClientOptions = CreatePacedCachedClientOptions

/**
 * The product's data.gov.uk catalogue ID.
 * The entry holds the reference dates, licence and file URLs.
 */
export const EA_CATALOGUE_PACKAGE_ID = "104434b0-5263-4c90-9b1e-e43b1d57c750"

/**
 * The licence the catalogue entry must declare.
 *
 * Any other value means the licence changed, and the build stops so someone can review the new terms.
 */
export const EA_EXPECTED_CATALOGUE_LICENCE = "Open Government Licence"

/**
 * The product's catalogue entry.
 */
export type FloodCatalogueRecord = CKANPackageRecord

/**
 * Client for the EA's WFS and OGC API Features endpoints and the product's catalogue entry.
 */
export class EAFloodClient extends APIClient<APIClientConfig> {
	/**
	 * Reads the catalogue entry, which holds the reference dates, licence and file URLs.
	 *
	 * The download URL must come from the catalogue.
	 * The EA file service keys files by an opaque `fileDataSetId`, so a hard-coded
	 * URL can go stale after a republish.
	 *
	 * @throws {Error} When the entry is for a different dataset, has no `revision` date,
	 * or declares a licence other than {@link EA_EXPECTED_CATALOGUE_LICENCE}.
	 */
	public async readCatalogueRecord(): Promise<FloodCatalogueRecord> {
		return readCKANPackageRecord(this, {
			packageID: EA_CATALOGUE_PACKAGE_ID,
			expectDatasetID: EA_FLOOD_DATASET_ID,
			expectLicence: EA_EXPECTED_CATALOGUE_LICENCE,
			context: "flood client",
		})
	}

	/**
	 * Reads the WFS feature count for the flood-zone layer without fetching geometry.
	 *
	 * The build compares this count with the geodatabase and refuses a file that disagrees.
	 */
	public async readFeatureCount(): Promise<number> {
		return readWFSFeatureCount(this, {
			wfsURL: `${EA_SPATIAL_BASE_URL}/wfs`,
			typeNames: `dataset-${EA_FLOOD_DATASET_ID}:${EA_FLOOD_LAYER}`,
			context: "flood client",
		})
	}

	/**
	 * Reads the layer's declared extent from the OGC API Features collection, in CRS84 order.
	 *
	 * The offline ingest checks against the constant in `vocabulary.ts`.
	 * This live value lets an online build confirm that constant.
	 */
	public async readDeclaredBBox(): Promise<[number, number, number, number]> {
		return readOGCCollectionBBox(this, {
			collectionURL: `${EA_SPATIAL_BASE_URL}/ogc/features/v1/collections/${EA_FLOOD_LAYER}`,
			context: "flood client",
		})
	}
}

/**
 * Creates an {@link EAFloodClient} with request pacing and a disk cache.
 */
export function createEAFloodClient(options: CreateFloodClientOptions = {}): EAFloodClient {
	return createPacedCachedClient(
		EAFloodClient,
		{
			displayName: "EAFlood",
			minRequestIntervalMs: EA_MIN_REQUEST_INTERVAL_MS,
			cacheTTLMs: EA_CACHE_TTL_MS,
			cacheDirectory: ["flood", "cache", "http"],
		},
		options
	)
}

/**
 * The ONS Open Geography boundary service, which supplies the outline of England.
 *
 * The EA says its mapping covers all of England but publishes no outline.
 * The build records the ONS boundary it used in `flood_map_extent`.
 */
export const ONS_BOUNDARY_BASE_URL =
	"https://services1.arcgis.com/ESMARspQHYMw9BZ9/arcgis/rest/services/Countries_December_2025_Boundaries_UK_BGC/FeatureServer/0"

/**
 * The ONS boundary product, generalised to 20 m and clipped to the coastline.
 *
 * The full-resolution product would give the same cells for a much larger download.
 * Coverage cells are kilometres across, and the interior test drops cells near the border.
 */
export const ONS_BOUNDARY_PRODUCT = "Countries (December 2025) Boundaries UK BGC"

/**
 * The attribution that ONS requires for reuse of its boundary products.
 */
export const ONS_BOUNDARY_ATTRIBUTION =
	"Contains National Statistics data © Crown copyright and database right 2025. " +
	"Contains OS data © Crown copyright and database right 2025."

/**
 * Licence of the ONS boundary data.
 */
export const ONS_BOUNDARY_LICENSE = "OGL-UK-3.0"

/**
 * Client for the ONS boundary service.
 */
export class ONSBoundaryClient extends APIClient<APIClientConfig> {
	/**
	 * Reads one country's outline as a WGS84 GeoJSON geometry.
	 *
	 * @throws {Error} When the service returns zero or several features for `countryName`.
	 * Several matches would mean the name column changed meaning.
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
				`flood client: the ONS boundary service returned ${features.length} features for ${stringifyJSON(countryName)}, expected exactly 1`
			)
		}

		const feature = features[0]!

		if (!feature.geometry) {
			throw new Error(`flood client: the ONS boundary feature for ${stringifyJSON(countryName)} carries no geometry`)
		}

		return {
			geometry: feature.geometry,
			code: feature.properties?.CTRY25CD ?? "",
			name: feature.properties?.CTRY25NM ?? countryName,
		}
	}
}

/**
 * Creates an {@link ONSBoundaryClient} with a one-year cache.
 *
 * ONS publishes each boundary vintage under a new service name, so the content at one URL does not change.
 */
export function createONSBoundaryClient(options: CreateFloodClientOptions = {}): ONSBoundaryClient {
	return createPacedCachedClient(
		ONSBoundaryClient,
		{
			displayName: "ONSBoundary",
			minRequestIntervalMs: EA_MIN_REQUEST_INTERVAL_MS,
			cacheTTLMs: 365 * 24 * 60 * 60 * 1000,
			cacheDirectory: ["flood", "cache", "http"],
		},
		options
	)
}
