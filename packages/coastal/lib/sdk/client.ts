/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Client for the Environment Agency's NCERM catalogue entry, ISO record and spatial services.
 *   The geodatabase download streams through `download.ts` instead of this client.
 *
 *   - The OGC service slug is spelled `ncern`. The correctly spelled slug returns 404, so
 *     `vocabulary.ts` keeps the misspelling as a constant.
 *   - The download host rejects HEAD and ignores `Range`, so file size cannot show freshness.
 *     {@linkcode EANCERMClient.readCatalogueRecord} reads the ISO revision date instead.
 *   - The abstract holds the attribution statement twice, and only the second copy has a year.
 *     {@linkcode parseAttributionStatement} rejects copies without a year.
 */

import {
	APIClient,
	readCKANPackageRecord,
	readOGCCollectionBBox,
	readWFSFeatureCount,
	type APIClientConfig,
	type CKANPackageRecord,
	assertNoOGCServiceException,
} from "@mailwoman/core/api"
import { createPacedCachedClient, type CreatePacedCachedClientOptions } from "@mailwoman/core/api/paced-client"
import { stringifyJSON } from "@mailwoman/core/json"

import { NCERM_ATTRIBUTION, NCERM_CATALOGUE_PACKAGE_ID, NCERM_DATASET_ID, NCERM_SERVICE_SLUG } from "#vocabulary"

/**
 * Root URL of the EA spatial-data service for NCERM, built on the misspelled service slug.
 */
export const EA_NCERM_SPATIAL_BASE_URL = `https://environment.data.gov.uk/spatialdata/${NCERM_SERVICE_SLUG}`

/**
 * The EA's CSW endpoint, which serves the ISO 19115 record.
 *
 * The dataset landing page is a client-side app, so a plain fetch cannot read it.
 */
export const EA_CSW_URL = "https://environment.data.gov.uk/discover/ea/csw"

/**
 * Minimum spacing between EA requests, in milliseconds.
 *
 * The EA publishes no rate limit for these services, so this value is courtesy pacing.
 */
export const EA_MIN_REQUEST_INTERVAL_MS = 500

/**
 * How long a cached EA metadata response stays fresh.
 *
 * The ISO record gives an annual maintenance frequency, so six hours is ample.
 */
const EA_CACHE_TTL_MS = 6 * 60 * 60 * 1000

/**
 * The licence value that the catalogue entry must carry.
 * A different value means the terms changed.
 */
export const EA_EXPECTED_CATALOGUE_LICENCE = "Open Government Licence"

/**
 * Options for {@link createEANCERMClient}.
 */
export type CreateCoastalClientOptions = CreatePacedCachedClientOptions

/**
 * The product's catalogue entry.
 */
export type CoastalCatalogueRecord = CKANPackageRecord

/**
 * Text that the published record puts before each copy of its attribution statement.
 */
const ATTRIBUTION_MARKER = "Attribution statement:"

const YEAR_PATTERN = /\b\d{4}\b/u

/**
 * Return the last attribution statement in `text` that contains a four-digit year.
 *
 * The record's abstract holds two copies, and the first copy has no year.
 * Each copy ends at the next marker or the next XML tag.
 *
 * The parser uses `indexOf` scans because the obvious regex backtracks polynomially on network input.
 *
 * @throws {Error} When no copy contains a year.
 */
export function parseAttributionStatement(text: string): string {
	const statements: string[] = []

	let cursor = 0

	for (;;) {
		const marker = text.indexOf(ATTRIBUTION_MARKER, cursor)

		if (marker === -1) break

		const from = marker + ATTRIBUTION_MARKER.length
		const nextMarker = text.indexOf(ATTRIBUTION_MARKER, from)
		const nextTag = text.indexOf("<", from)

		// A missing marker or tag counts as the end of the string, because `-1` would win `Math.min`.
		const end = Math.min(nextMarker === -1 ? text.length : nextMarker, nextTag === -1 ? text.length : nextTag)
		const statement = text.slice(from, end).trim()

		if (statement) {
			statements.push(statement)
		}

		cursor = from
	}

	const dated = statements.filter((statement) => YEAR_PATTERN.test(statement))

	if (!dated.length) {
		throw new Error(
			`coastal client: no attribution statement in the record carries a year (found ${statements.length}: ${stringifyJSON(statements)}) — ` +
				"the abstract's first copy is inherited from the superseded record and carries none, so a yearless statement is refused rather than shipped as the licence condition"
		)
	}

	return dated.at(-1)!
}

/**
 * Client for the EA's catalogue entry, ISO record, WFS and OGC API Features endpoints.
 */
export class EANCERMClient extends APIClient<APIClientConfig> {
	/**
	 * Read the catalogue entry, with its reference dates, licence and file URLs.
	 *
	 * The download URL comes from the entry because the file service keys on an opaque
	 * ID that changes when the product is republished.
	 *
	 * @throws {Error} When the entry is for a different dataset, has no `revision` date,
	 * or carries a licence other than {@link EA_EXPECTED_CATALOGUE_LICENCE}.
	 */
	public async readCatalogueRecord(): Promise<CoastalCatalogueRecord> {
		return readCKANPackageRecord(this, {
			packageID: NCERM_CATALOGUE_PACKAGE_ID,
			expectDatasetID: NCERM_DATASET_ID,
			expectLicence: EA_EXPECTED_CATALOGUE_LICENCE,
			context: "coastal client",
		})
	}

	/**
	 * Read the live attribution statement from the ISO record.
	 *
	 * The build compares it with the `NCERM_ATTRIBUTION` constant, because OGL
	 * v3.0 makes the statement a licence condition.
	 */
	public async readAttributionStatement(): Promise<string> {
		const { data } = await this.fetch<string>({
			method: "GET",
			url: EA_CSW_URL,
			responseType: "text",
			params: {
				service: "CSW",
				version: "2.0.2",
				request: "GetRecordById",
				id: NCERM_DATASET_ID,
				outputSchema: "http://www.isotc211.org/2005/gmd",
				elementSetName: "full",
			},
		})

		assertNoOGCServiceException(data, "coastal client")

		return parseAttributionStatement(data)
	}

	/**
	 * Read one layer's feature count from the WFS without downloading geometry.
	 *
	 * The build compares it with the geodatabase count to catch a stale or truncated file.
	 */
	public async readFeatureCount(layer: string): Promise<number> {
		return readWFSFeatureCount(this, {
			wfsURL: `${EA_NCERM_SPATIAL_BASE_URL}/wfs`,
			typeNames: `dataset-${NCERM_DATASET_ID}:${layer}`,
			context: "coastal client",
			subject: layer,
		})
	}

	/**
	 * Read the extent that one OGC API Features collection declares, in CRS84 order.
	 *
	 * The build compares it with the offline constant in `vocabulary.ts`.
	 */
	public async readDeclaredBBox(layer: string): Promise<[number, number, number, number]> {
		return readOGCCollectionBBox(this, {
			collectionURL: `${EA_NCERM_SPATIAL_BASE_URL}/ogc/features/v1/collections/${layer}`,
			context: "coastal client",
			subject: layer,
		})
	}
}

/**
 * Throw when the live attribution statement differs from the one this build ships.
 *
 * @throws {Error} When the live statement differs from {@link NCERM_ATTRIBUTION}.
 */
export function assertAttributionUnchanged(live: string): void {
	if (live === NCERM_ATTRIBUTION) return

	throw new Error(
		`coastal client: the published attribution statement is ${stringifyJSON(live)}, and this build ships ${stringifyJSON(NCERM_ATTRIBUTION)} — ` +
			"OGL v3.0 makes the statement a licence condition, so a change in it changes what a re-user has to publish"
	)
}

/**
 * Build an {@link EANCERMClient} with a disk cache and request pacing.
 */
export function createEANCERMClient(options: CreateCoastalClientOptions = {}): EANCERMClient {
	return createPacedCachedClient(
		EANCERMClient,
		{
			displayName: "EANCERM",
			minRequestIntervalMs: EA_MIN_REQUEST_INTERVAL_MS,
			cacheTTLMs: EA_CACHE_TTL_MS,
			cacheDirectory: ["coastal", "cache", "http"],
		},
		options
	)
}
