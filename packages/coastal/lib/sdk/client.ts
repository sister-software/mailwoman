/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The Environment Agency's catalogue entry, ISO record and spatial services, read through
 *   {@linkcode APIClient}.
 *
 *   THESE ARE API REQUESTS AND THEY GO THROUGH `APIClient`. Small bodies, repeated calls, a third-party
 *   host — the pacing, bounded retry, response caching and `ResourceError` mapping are exactly what they
 *   need. The 70 MB geodatabase is NOT one of them: it is a file transfer, it streams to disk on raw
 *   `fetch`, and `download.ts` says so in place.
 *
 *   THREE MEASURED CLIENT BEHAVIORS ARE ENCODED HERE RATHER THAN WRITTEN DOWN SOMEWHERE ELSE.
 *
 *   1. THE OGC SERVICE SLUG IS A MISSPELLING OF THE PRODUCT. `ncerm-national-2024` answers HTTP 404;
 *      `ncern-national-2024` answers HTTP 200 with 110,478 bytes of `GetCapabilities`. Correcting the
 *      spelling loses the service half of the two-path verification and reports a clean run while doing it,
 *      so the misspelling is a named constant in `vocabulary.ts` and never assembled from the product name.
 *   2. FRESHNESS CANNOT BE PROBED BY CONTENT LENGTH. The download host answers `HEAD` with HTTP 405 and
 *      IGNORES `Range` — a ranged GET returns 200 with the whole 70,296,882-byte body — so a size probe
 *      starts a real transfer. {@linkcode EANCERMClient.readCatalogueRecord} reads the ISO revision date out
 *      of the catalogue entry instead, which is the authority's own statement about what changed.
 *   3. THE ATTRIBUTION COMES FROM THE STRUCTURED LICENCE FIELD. The abstract carries the statement TWICE and
 *      the first copy — inherited from the superseded 2018–2021 record — has no year. The ISO record carries
 *      no `gmd:credit` element at all. {@linkcode parseAttributionStatement} refuses the yearless copy, so a
 *      reader that falls back to the abstract cannot take the wrong one.
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

import { NCERM_ATTRIBUTION, NCERM_CATALOGUE_PACKAGE_ID, NCERM_DATASET_ID, NCERM_SERVICE_SLUG } from "#vocabulary"

// Re-exported so a caller branching on this client's failures needs exactly one import.
export { isTransientResourceError } from "@mailwoman/core/api"
export { ResourceError } from "@mailwoman/core/errors"

/**
 * The EA's spatial-data service root for NCERM. Built on the MISSPELLED slug — see this file's header.
 */
export const EA_NCERM_SPATIAL_BASE_URL = `https://environment.data.gov.uk/spatialdata/${NCERM_SERVICE_SLUG}`

/**
 * The EA's CSW, where the ISO 19115 record is readable. The dataset landing page is a client-side application and
 * returns only its shell to a fetch, so this is the primary source that can actually be read.
 */
export const EA_CSW_URL = "https://environment.data.gov.uk/discover/ea/csw"

/**
 * The catalogue API the data.gov.uk entry is read from.
 */
export { CKAN_CATALOGUE_API_BASE_URL as CATALOGUE_API_BASE_URL } from "@mailwoman/core/api"

/**
 * Minimum spacing between EA requests, in milliseconds.
 *
 * The EA publishes no rate limit for these services and its WFS `GetCapabilities` reports `<ows:Fees>NONE`, so this is
 * courtesy pacing rather than a published ceiling — stated as such rather than dressed up as a measured limit. Two
 * requests a second is far below anything a public OGC endpoint is provisioned for and costs a build nothing: the
 * acquisition path makes single-digit numbers of calls, and the verification a few dozen.
 */
export const EA_MIN_REQUEST_INTERVAL_MS = 500

/**
 * How long a cached EA metadata response stays fresh.
 *
 * Six hours, chosen against the product's cadence rather than a wall-clock intuition. The ISO
 * `MD_MaintenanceFrequencyCode` is `annually` and no prose names a publication month, so the revision date moves at
 * most once a year. A shorter TTL buys nothing.
 */
const EA_CACHE_TTL_MS = 6 * 60 * 60 * 1000

/**
 * The licence value the catalogue entry must carry. A different value is a licence change, and a build that absorbed
 * one would ship an artifact under terms nobody checked.
 */
export const EA_EXPECTED_CATALOGUE_LICENCE = "Open Government Licence"

export type CreateCoastalClientOptions = CreatePacedCachedClientOptions

/**
 * What the catalogue says about the product.
 */
export type CoastalCatalogueRecord = CKANPackageRecord

/**
 * The marker the published record puts before each copy of its attribution statement.
 */
const ATTRIBUTION_MARKER = "Attribution statement:"

/**
 * A four-digit year, anywhere in a statement. Bounded and anchored to word boundaries, so it is linear on any input.
 */
const YEAR_PATTERN = /\b\d{4}\b/u

/**
 * The attribution statement carrying a year, taken from a block of text that may hold the statement more than once.
 *
 * THE FIRST COPY IS THE WRONG ONE, MEASURED. The 2024 record's abstract ends "…© Environment Agency copyright and/or
 * database right Attribution statement: © Environment Agency copyright and/or database right 2025. All rights reserved.
 * " — two copies, the first inherited from the superseded record and carrying no year. A parse that took the first
 * match would ship an attribution naming no year, which is a licence condition stated incorrectly rather than a
 * cosmetic slip.
 *
 * INDEX SCANS RATHER THAN A REGEX, AND THAT IS A CORRECTNESS CHOICE RATHER THAN A SPEED ONE. The obvious form —
 * `/Attribution statement:\s*([^<]*?)(?=Attribution statement:|<|$)/g` — backtracks polynomially, because the `\s*` and
 * the lazy run overlap on whitespace and the lookahead's `$` alternative makes every position a candidate end. The
 * input here is a 27,643-byte document that arrived over the network, so "a pathological one cannot happen" is not a
 * claim this reader gets to make. Two `indexOf` calls per copy answer the same question in one pass.
 *
 * EACH COPY ENDS AT THE NEXT MARKER OR THE NEXT TAG, whichever comes first. The statement sits inside a
 * `gco:CharacterString`, so a scan that ran to the end of the document would return several kilobytes of XML that
 * happens to contain a year.
 *
 * @throws {Error} When no copy carries a four-digit year. A statement without one is not this product's attribution,
 *   and guessing which copy was meant is exactly the choice that produced the malformed pair.
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

		// `Math.min` over the two ends, with an absent end reading as the end of the string rather than as `-1` — which
		// would sort BELOW every real index and truncate every statement to nothing.
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
			`coastal client: no attribution statement in the record carries a year (found ${statements.length}: ${JSON.stringify(statements)}) — ` +
				"the abstract's first copy is inherited from the superseded record and carries none, so a yearless statement is refused rather than shipped as the licence condition"
		)
	}

	return dated.at(-1)!
}

/**
 * A client for the EA's catalogue entry, ISO record, WFS and OGC API Features endpoints.
 */
export class EANCERMClient extends APIClient<APIClientConfig> {
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
	public async readCatalogueRecord(): Promise<CoastalCatalogueRecord> {
		return readCKANPackageRecord(this, {
			packageID: NCERM_CATALOGUE_PACKAGE_ID,
			expectDatasetID: NCERM_DATASET_ID,
			expectLicence: EA_EXPECTED_CATALOGUE_LICENCE,
			context: "coastal client",
		})
	}

	/**
	 * The attribution statement the published record carries, checked against the constant the build ships.
	 *
	 * Read at build time rather than trusted from `vocabulary.ts`: the constant is what the artifact is stamped with
	 * offline, and this is the live value it is reconciled with when the network is available. OGL v3.0 makes the
	 * statement a licence condition, so a change in it is a change in what a re-user has to publish.
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
	 * The feature count the WFS reports for one layer — `resultType=hits`, which returns the count without a single
	 * geometry.
	 *
	 * This is the SECOND path in the build's two-path agreement check: the same authority, a different distribution
	 * channel. A geodatabase whose feature count disagrees with the live service is not a file this build should be
	 * writing into a sealed artifact.
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
	 * The extent one OGC API Features collection declares, in CRS84 order.
	 *
	 * Read at build time rather than trusted from the constant in `vocabulary.ts`: the constant is what the ingest
	 * asserts against offline, and this is the live value it is reconciled with when the network is available.
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
 * Refuse an attribution the published record no longer matches.
 *
 * @throws {Error} When the live statement differs from {@link NCERM_ATTRIBUTION}.
 */
export function assertAttributionUnchanged(live: string): void {
	if (live === NCERM_ATTRIBUTION) return

	throw new Error(
		`coastal client: the published attribution statement is ${JSON.stringify(live)}, and this build ships ${JSON.stringify(NCERM_ATTRIBUTION)} — ` +
			"OGL v3.0 makes the statement a licence condition, so a change in it changes what a re-user has to publish"
	)
}

/**
 * Build an {@link EANCERMClient} with the disk cache and pacing this package's acquisition path expects.
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
