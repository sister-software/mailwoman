/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Harvests Estonia's INSPIRE Addresses (AD) theme into the newline-delimited JSON file that
 * `#ee/adapters/ads/adapter` reads.
 *
 * Maa- ja Ruumiamet publishes the Aadressiandmete süsteem through GeoServer at
 * {@linkcode EE_ADS_WFS}. The service's dataset record states Creative Commons CC0 1.0 in
 * `otherConstraints`, which the address-source register elected under `spdx` `CC0-1.0`. CC0 reserves
 * no act, so paging the service and storing what it returns is granted and the harvest needs no
 * attribution clause.
 *
 * `#tools/fetch/inspire-addresses` owns the capabilities read and the GeoJSON page read, and
 * `#tools/fetch/wfs-harvest` owns the appending, the manifest and the resumption. This module states
 * what is particular to Estonia, which is four measurements taken on 2026-10-02:
 *
 * 1. The payload needs no component resolution. GeoServer flattens the application schema here, so
 *    each `component<n>_xlink_href` has a sibling `component<n>_xlink_title` carrying the referenced
 *    feature's value, and the adapter reads the titles. The harvest therefore takes one feature type
 *    rather than the five a harmonized INSPIRE service splits an address across.
 * 2. `resultType=hits` at `startIndex=1` reports `numberMatched="729973"` and a feature page reports
 *    the same number, so this service's count is real. It is read through
 *    `readCheckedWFSFeatureCount`, which proves the number against a page before a caller uses it,
 *    and no count is written into this file.
 * 3. The service honors a sort. `ImplementsSorting` is `TRUE`, `sortBy=gml_id` answers HTTP 200 and
 *    `sortBy=gml_id D` returns the type's last features first, which is what proves the parameter is
 *    applied rather than accepted and dropped. `sortBy=gml:identifier` and `sortBy=inspireId` answer
 *    HTTP 400 `Illegal property name`, so the sort property is one of the flattened names.
 * 4. A `count=10000` page of `application/json` is 31,198,909 bytes and takes about 6 seconds. At
 *    729,973 features that is 73 pages and about 2.3 GB, plus three requests for the capabilities and
 *    the checked count.
 *
 * The harvest writes one feature per line, which is what lets the adapter stream the whole extract
 * without holding a page. The `FeatureCollection` envelope is dropped: its counts describe one page
 * and the manifest records them per page instead.
 */

import { readCheckedWFSFeatureCount, type APIClient, type ReadWFSFeatureCountOptions } from "@mailwoman/core/api"
import { stringifyJSON } from "@mailwoman/core/json"
import type { PathBuilderLike } from "path-ts"

import type { BaseFetchOptions, FetchSummary } from "#tools/fetch/download"
import { readFeaturePage, readWFSCapabilities } from "#tools/fetch/inspire-addresses"
import {
	harvestPagedWFS,
	runWFSHarvest,
	statedFeatureCount,
	type HarvestedPayload,
	type WFSHarvestManifest,
} from "#tools/fetch/wfs-harvest"

/**
 * The service this module harvests.
 */
export const EE_ADS_WFS = "https://inspire.geoportaal.ee/geoserver/AD_Address/wfs"

/**
 * The qualified name the service publishes its addresses under.
 *
 * Read from the capabilities document per run.
 * This constant is the name a refusal quotes when the document stops publishing an Addresses type.
 */
export const EE_ADS_TYPE_NAME = "AD_Address:AD.Address"

/**
 * The property the pages are ordered by.
 *
 * A flattened property name, because the service refuses `gml:identifier`
 * and `inspireId` with HTTP 400 `Illegal property name`.
 */
export const EE_ADS_SORT_BY = "gml_id"

/**
 * Features per page.
 *
 * The service's `CountDefault` is 1,000,000 and it honors `count=10000`, which is where the page
 * size is set: a 10,000-feature page is 31,198,909 bytes, and a larger page buys fewer requests
 * at the cost of holding a larger body in memory and losing more work when one request fails.
 */
export const EE_ADS_PAGE_SIZE = 10_000

/**
 * The file the adapter's `inputPath` points at, inside the harvest directory.
 */
export const EE_ADS_HARVEST_FILE = "address.jsonl"

/**
 * The adapter slug this module fetches for, and the directory it writes under.
 */
const SLUG = "ads"

/**
 * Names the service in every refusal this module raises.
 */
const CONTEXT = "ee ads wfs"

/**
 * The license the address-source register elected for this publisher.
 */
const LICENSE = "CC0-1.0"

/**
 * The spacing between requests.
 *
 * The service answers a 10,000-feature page in about 6 seconds, so this is not what limits the harvest.
 * It bounds the harvest to one request per second against a government host whose published terms
 * state no rate, which the shorter requests — the capabilities and the count — would otherwise exceed.
 */
const MIN_REQUEST_INTERVAL_MS = 1000

/**
 * One page of features as newline-delimited JSON, one feature per line.
 *
 * A trailing newline on a non-empty page, so the next page's first feature starts its own line.
 */
export function featuresAsJSONL(features: readonly unknown[]): string {
	if (!features.length) return ""

	return `${features.map((feature) => stringifyJSON(feature)).join("\n")}\n`
}

export interface HarvestADSOptions {
	/**
	 * Where the harvest is written.
	 *
	 * The adapter reads {@linkcode EE_ADS_HARVEST_FILE} inside it.
	 */
	outputDir: PathBuilderLike
	/**
	 * Features per page, defaulting to {@linkcode EE_ADS_PAGE_SIZE}.
	 */
	pageSize?: number
	/**
	 * Stop once the manifest holds this many pages, for a probe rather than a full harvest.
	 */
	maxPages?: number
	signal?: AbortSignal
	report?: (line: string) => void
}

/**
 * Harvests the service into `options.outputDir` and writes the manifest beside the data file.
 *
 * The capabilities document is read first, so the type name, the JSON format
 * and the paging support come from the service rather than from this file.
 * A service that stops publishing any of the three raises here rather than
 * producing a harvest of the wrong thing.
 *
 * @returns The manifest as written.
 */
export async function harvestADSEE(
	client: Pick<APIClient, "fetch">,
	options: HarvestADSOptions
): Promise<WFSHarvestManifest> {
	const capabilities = await readWFSCapabilities(client, { wfsURL: EE_ADS_WFS, context: CONTEXT })
	const typeName = capabilities.typeNames.Address

	if (!typeName) {
		throw new Error(
			`${CONTEXT}: the capabilities document publishes no Addresses feature type, so ${EE_ADS_TYPE_NAME} could not be confirmed`
		)
	}

	if (!capabilities.jsonFormat) {
		throw new Error(
			`${CONTEXT}: the service advertises no JSON output format, and the adapter reads newline-delimited JSON — it advertises ${capabilities.outputFormats.join(", ")}`
		)
	}

	if (!capabilities.supportsPaging) {
		throw new Error(
			`${CONTEXT}: the service does not advertise ImplementsResultPaging, and such a service answers every page with the first, so a paged harvest would store one page repeated`
		)
	}

	const countOptions: ReadWFSFeatureCountOptions = { wfsURL: EE_ADS_WFS, typeNames: typeName, context: CONTEXT }

	// The cap comes from the service's own `CountDefault`, because a `numberMatched` equal
	// to it cannot be told apart from the largest page the service will serve.
	const featureCount = statedFeatureCount(
		await readCheckedWFSFeatureCount(client, countOptions),
		capabilities.countDefault
	)

	options.report?.(`  Feature count: ${featureCount.count ?? "not stated"} — ${featureCount.because}`)

	return harvestPagedWFS({
		context: CONTEXT,
		source: SLUG,
		outputDir: options.outputDir,
		filename: EE_ADS_HARVEST_FILE,
		request: {
			wfsURL: EE_ADS_WFS,
			typeName,
			outputFormat: capabilities.jsonFormat,
			sortBy: EE_ADS_SORT_BY,
		},
		license: LICENSE,
		// CC0 reserves no act, so the elected terms require none.
		attribution: "",
		featureCount,
		pageSize: options.pageSize ?? EE_ADS_PAGE_SIZE,
		maxPages: options.maxPages,
		signal: options.signal,
		report: options.report,
		readPage: async ({ startIndex, count }): Promise<HarvestedPayload> => {
			const page = await readFeaturePage(client, {
				wfsURL: EE_ADS_WFS,
				typeName,
				outputFormat: capabilities.jsonFormat ?? "",
				count,
				startIndex,
				supportsPaging: capabilities.supportsPaging,
				sortBy: EE_ADS_SORT_BY,
				context: CONTEXT,
			})

			return {
				payload: featuresAsJSONL(page.features),
				numberReturned: page.numberReturned,
				numberMatched: page.numberMatched,
				retrievedAt: page.timeStamp,
			}
		},
	})
}

export type FetchADSEEOptions = BaseFetchOptions &
	Pick<HarvestADSOptions, "maxPages" | "pageSize" | "signal"> & {
		/**
		 * An injected client, for a test that supplies its own transport.
		 *
		 * A caller that leaves it out gets a paced client of this module's own.
		 */
		client?: Pick<APIClient, "fetch">
	}

/**
 * Harvests Estonia's addresses under `<outRoot>/ads/`, for `mailwoman corpus fetch ads-ee`.
 *
 * Re-runnable: a complete harvest whose file still hashes to the manifest's digest makes
 * no request, and an interrupted one resumes at the page after the last that reached disk.
 */
export async function fetchADSEE(options: FetchADSEEOptions, report?: (line: string) => void): Promise<FetchSummary> {
	const pageSize = options.pageSize ?? EE_ADS_PAGE_SIZE

	return runWFSHarvest(
		{
			slug: SLUG,
			outRoot: options.outRoot,
			filename: EE_ADS_HARVEST_FILE,
			expect: { wfsURL: EE_ADS_WFS, sortBy: EE_ADS_SORT_BY, pageSize },
			displayName: "ee-ads",
			minRequestIntervalMs: MIN_REQUEST_INTERVAL_MS,
			client: options.client,
			maxPages: options.maxPages,
			harvest: async (client) =>
				harvestADSEE(client, {
					outputDir: options.outRoot(SLUG),
					pageSize,
					maxPages: options.maxPages,
					signal: options.signal,
					report,
				}),
		},
		report
	)
}
