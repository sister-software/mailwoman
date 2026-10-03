/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Harvests Slovakia's INSPIRE Addresses (AD) theme into the GML documents that
 * `#sk/adapters/inspire/adapter` reads.
 *
 * The Ministerstvo vnútra Slovenskej republiky publishes the national address register through
 * GeoServer at {@linkcode SK_INSPIRE_WFS}. Its register record,
 * `https://rpi.gov.sk/api/collection_record/86dea70e-a55b-4241-bd63-4024b3f76b72`, names a WMS and
 * this WFS as the theme's only distributions and states one condition of use, `Neuplatňujú sa žiadne
 * podmienky (CC0 Voľné dielo)`, which the address-source register elected. There is no INSPIRE ATOM
 * download service for this theme: the feeds under `inspirews.skgeodesy.sk` belong to the
 * Geodetický a kartografický ústav, which is a different publisher and a different record.
 *
 * `#tools/fetch/wfs-harvest` owns the page read, the appending, the manifest and the resumption.
 * What is particular to Slovakia is that an address is assembled from five feature types rather
 * than read from one, which is what shapes the layout this writes.
 *
 * ## Five types, five documents, one directory
 *
 * `ad:Address` carries a locator and references its street, its settlement part, its administrative
 * units and its postcode through `ad:component`. The adapter resolves those references locally
 * against an index it builds in a first pass over every document in `inputPath`, so every type has
 * to be on disk before the first address is composed. Measured 2026-10-03, `resultType=hits` past
 * index 0 reports 1,704,196 `ad:Address`, 29,315 `ad:ThoroughfareName`, 3,015 `ad:AdminUnitName`,
 * 1,769 `ad:AddressAreaName` and 1,415 `ad:PostalDescriptor`.
 *
 * Each type is harvested into its own directory under the source root, because a harvest's manifest
 * sits at a fixed name beside its data file and five types sharing one directory would overwrite
 * each other's manifest. A run would then re-harvest every type, and the 341 address pages are the
 * expensive part of this acquisition:
 *
 *     sk-inspire/Address/Address.gml            + MANIFEST.json
 *     sk-inspire/ThoroughfareName/…             + MANIFEST.json
 *     …
 *
 * The adapter reads `inputPath` recursively, so that root is what {@linkcode skInspireInputPath}
 * states. The four component types are harvested before the addresses, so an interrupted run leaves
 * the small side of the join complete rather than leaving addresses whose component references the
 * harvest cannot answer.
 *
 * ## What the service states about itself
 *
 * Measured 2026-10-03: `ImplementsResultPaging` is `TRUE`, `ImplementsSorting` is `TRUE`,
 * `CountDefault` is 5000, and the advertised `GetFeature` formats include
 * `application/gml+xml; version=3.2`, which is the one the adapter's markup reader takes. A
 * 5,000-feature page of `ad:Address` answered in 17 seconds carrying 13,879,456 bytes, so a full
 * harvest of that type is 341 requests and roughly 4.7 GB.
 *
 * `CountDefault` is 5000 and no type reports 5000 features, so `statedFeatureCount` accepts each
 * type's `numberMatched` as a count rather than refusing it as a page cap. The register records one
 * response in nine that carried no `numberMatched` attribute at all;
 * `readCheckedWFSFeatureCount` reads such a response as no usable count, and the harvest then ends
 * on the first page that returns no features instead of recording a wrong total.
 */

import { readCheckedWFSFeatureCount, type APIClient } from "@mailwoman/core/api"
import type { PathBuilderLike } from "path-ts"

import { SK_INSPIRE_ADAPTER_ID, SK_INSPIRE_DEFAULT_LICENSE } from "#sk/adapters/inspire/adapter"
import type { BaseFetchOptions, FetchSummary } from "#tools/fetch/download"
import { readWFSCapabilities, type WFSCapabilities } from "#tools/fetch/inspire-addresses"
import {
	collectionOpeningTag,
	harvestPagedWFS,
	readWFSMarkupPage,
	rootContent,
	runWFSHarvest,
	statedFeatureCount,
	type FeatureCountStatement,
	type HarvestedPayload,
	type WFSHarvestManifest,
} from "#tools/fetch/wfs-harvest"

/**
 * The service this module harvests.
 */
export const SK_INSPIRE_WFS = "https://rageo.minv.sk/geoserver/ad/wfs"

/**
 * The output format the harvest asks for, which is the GML the adapter's markup reader takes.
 */
export const SK_INSPIRE_OUTPUT_FORMAT = "application/gml+xml; version=3.2"

/**
 * The property the pages are ordered by.
 *
 * Every AD feature type carries `ad:inspireId`, so one sort serves all five.
 * Without a sort, a resumed harvest would rest on the service returning the same
 * features in the same order as the earlier run, which no WFS guarantees.
 */
export const SK_INSPIRE_SORT_BY = "ad:inspireId"

/**
 * Features per page.
 *
 * The service's own `CountDefault`, which is the largest page it will serve.
 */
export const SK_INSPIRE_PAGE_SIZE = 5000

/**
 * The feature types harvested, in the order they are taken.
 *
 * The four component types come first, each in the thousands, so an interrupted run
 * leaves the index side of the adapter's join complete.
 * `Address` is last and is the 1.7-million-feature side.
 */
export const SK_INSPIRE_TYPES = [
	"ThoroughfareName",
	"AddressAreaName",
	"AdminUnitName",
	"PostalDescriptor",
	"Address",
] as const

/**
 * One of the five feature types this module harvests.
 */
export type SKInspireType = (typeof SK_INSPIRE_TYPES)[number]

/**
 * The XML declaration each assembled document opens with.
 *
 * The service's own pages declare UTF-8, and the harvest is written as UTF-8.
 */
const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>\n'

/**
 * The adapter slug this module fetches for, and the directory it writes under.
 */
const SLUG = SK_INSPIRE_ADAPTER_ID

/**
 * Names the service in every refusal this module raises.
 */
const CONTEXT = "sk-inspire wfs"

/**
 * The spacing between requests.
 *
 * A 5,000-feature page answered in 17 seconds, so the service's own latency already
 * spaces a serial harvest further apart than this.
 * The interval is the ceiling a run is held to rather than the rate it achieves.
 */
const MIN_REQUEST_INTERVAL_MS = 1000

/**
 * The data file one type is harvested into, inside that type's own directory.
 */
export function skInspireHarvestFile(type: SKInspireType): string {
	return `${type}.gml`
}

/**
 * What the service states about itself, with the claims this harvest depends on checked.
 *
 * The qualified type names come from the capabilities document rather than from a
 * constant here, because a service's prefix is its own: this one publishes `ad:Address`
 * and Estonia's publishes `AD_Address:AD.Address`.
 *
 * @throws When the service stops publishing one of the five types, does not advertise
 * the GML format the adapter reads, or does not advertise result paging.
 */
export async function readSKInspireCapabilities(client: Pick<APIClient, "fetch">): Promise<WFSCapabilities> {
	const capabilities = await readWFSCapabilities(client, { wfsURL: SK_INSPIRE_WFS, context: CONTEXT })

	const absent = SK_INSPIRE_TYPES.filter((type) => !capabilities.typeNames[type])

	if (absent.length) {
		throw new Error(
			`${CONTEXT}: the capabilities document publishes no ${absent.join(", ")} feature type, and an address ` +
				`references every one of the five, so the adapter's join could not be built from this service`
		)
	}

	if (!capabilities.outputFormats.includes(SK_INSPIRE_OUTPUT_FORMAT)) {
		throw new Error(
			`${CONTEXT}: the service does not advertise ${SK_INSPIRE_OUTPUT_FORMAT}, which is the format the adapter reads — it advertises ${capabilities.outputFormats.join(", ")}`
		)
	}

	if (!capabilities.supportsPaging) {
		throw new Error(
			`${CONTEXT}: the service does not advertise ImplementsResultPaging, and such a service answers every page with the first, so a paged harvest would store one page repeated`
		)
	}

	return capabilities
}

/**
 * The count the service states for one type, with how it was obtained.
 *
 * `statedFeatureCount` carries no count forward where the reported number equals
 * the advertised page cap, because such a number describes the largest page the
 * service will serve rather than what the type holds.
 * This service's cap is 5000 and no type reports 5000.
 */
export async function readSKInspireFeatureCount(
	client: Pick<APIClient, "fetch">,
	options: { typeName: string; pageCap: number | null }
): Promise<FeatureCountStatement> {
	return statedFeatureCount(
		await readCheckedWFSFeatureCount(client, {
			wfsURL: SK_INSPIRE_WFS,
			typeNames: options.typeName,
			context: CONTEXT,
		}),
		options.pageCap
	)
}

export interface HarvestSKInspireTypeOptions {
	/**
	 * Where this type's harvest is written.
	 *
	 * The adapter reads {@linkcode skInspireHarvestFile} inside it.
	 */
	outputDir: PathBuilderLike
	/**
	 * The qualified name the capabilities document gives this type.
	 */
	typeName: string
	type: SKInspireType
	/**
	 * The `CountDefault` the service advertises, read from the capabilities document.
	 *
	 * Passed in rather than read here, so one capabilities request serves both the type name
	 * and the cap a reported count is checked against.
	 */
	pageCap: number | null
	/**
	 * Features per page, capped at {@linkcode SK_INSPIRE_PAGE_SIZE} because the service caps it there.
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
 * Harvests one feature type into its own directory, recording each page in a manifest beside it.
 *
 * @returns The manifest as written.
 */
export async function harvestSKInspireType(
	client: Pick<APIClient, "fetch">,
	options: HarvestSKInspireTypeOptions
): Promise<WFSHarvestManifest> {
	const { typeName, type } = options
	const pageSize = Math.min(options.pageSize ?? SK_INSPIRE_PAGE_SIZE, SK_INSPIRE_PAGE_SIZE)

	const featureCount = await readSKInspireFeatureCount(client, { typeName, pageCap: options.pageCap })

	options.report?.(`  ${type}: ${featureCount.count ?? "no stated count"} — ${featureCount.because}`)

	return await harvestPagedWFS({
		context: `${CONTEXT} ${typeName}`,
		source: SLUG,
		outputDir: options.outputDir,
		filename: skInspireHarvestFile(type),
		request: {
			wfsURL: SK_INSPIRE_WFS,
			typeName,
			outputFormat: SK_INSPIRE_OUTPUT_FORMAT,
			sortBy: SK_INSPIRE_SORT_BY,
		},
		license: SK_INSPIRE_DEFAULT_LICENSE,
		// The elected statement names no attribution clause.
		// Crediting the Ministerstvo vnútra SR stays good practice.
		attribution: "",
		featureCount,
		pageSize,
		maxPages: options.maxPages,
		signal: options.signal,
		report: options.report,
		readPage: async ({ startIndex, count }): Promise<HarvestedPayload> => {
			const page = await readWFSMarkupPage(client, {
				wfsURL: SK_INSPIRE_WFS,
				context: `${CONTEXT} ${typeName}`,
				params: {
					typeNames: typeName,
					outputFormat: SK_INSPIRE_OUTPUT_FORMAT,
					sortBy: SK_INSPIRE_SORT_BY,
					count: String(count),
					startIndex: String(startIndex),
				},
			})

			return {
				payload: rootContent(page.body, page.root, `${CONTEXT} ${typeName}`),
				header: `${XML_DECLARATION}${collectionOpeningTag(page.root)}`,
				footer: `</${page.root.name}>\n`,
				numberReturned: page.numberReturned,
				numberMatched: page.numberMatched,
				retrievedAt: page.timeStamp,
			}
		},
	})
}

/**
 * Per-invocation options for the registry entry.
 */
export interface FetchSKInspireOptions extends BaseFetchOptions {
	/**
	 * Features per page, capped at {@linkcode SK_INSPIRE_PAGE_SIZE}.
	 */
	pageSize?: number
	/**
	 * Stop each type once its manifest holds this many pages, for a probe rather than a full harvest.
	 */
	maxPages?: number
	signal?: AbortSignal
	/**
	 * An injected client, for a test that supplies its own transport.
	 */
	client?: Pick<APIClient, "fetch">
}

/**
 * The directory `#sk/adapters/inspire/adapter` reads, given the root a fetch wrote under.
 *
 * A directory rather than a file, because the five feature types are five documents
 * and the adapter indexes four of them before it composes an address out of the fifth.
 */
export function skInspireInputPath(outRoot: BaseFetchOptions["outRoot"]): PathBuilderLike {
	return outRoot(SLUG)
}

/**
 * Harvests Slovakia's five AD feature types under `<outRoot>/sk-inspire/<type>/`,
 * for `mailwoman corpus fetch sk-inspire`.
 *
 * Each type is reported separately and a type that fails does not stop the rest, because the
 * documents are read together by the adapter and a partial directory is still worth resuming.
 * Re-runnable per type: a complete harvest whose file still hashes to its manifest's digest
 * makes no request, and an interrupted one resumes at the page after the last that reached disk.
 */
export async function fetchSKInspire(
	options: FetchSKInspireOptions,
	report?: (line: string) => void
): Promise<FetchSummary> {
	const pageSize = Math.min(options.pageSize ?? SK_INSPIRE_PAGE_SIZE, SK_INSPIRE_PAGE_SIZE)

	report?.(`=== ${SLUG}: ${SK_INSPIRE_TYPES.length} feature types from ${SK_INSPIRE_WFS}`)

	const summary: FetchSummary = { fetched: 0, skipped: 0, failed: 0, failedCodes: [] }

	for (const type of SK_INSPIRE_TYPES) {
		if (options.signal?.aborted) break

		const typeSummary = await runWFSHarvest(
			{
				slug: type,
				// The harvest directory is the type's own, inside this source's root,
				// so each type keeps its own manifest instead of overwriting the previous type's.
				outRoot: (segment) => options.outRoot(SLUG, segment),
				filename: skInspireHarvestFile(type),
				expect: { wfsURL: SK_INSPIRE_WFS, sortBy: SK_INSPIRE_SORT_BY, pageSize },
				displayName: `${SLUG} ${type}`,
				minRequestIntervalMs: MIN_REQUEST_INTERVAL_MS,
				client: options.client,
				maxPages: options.maxPages,
				harvest: async (client) => {
					const capabilities = await readSKInspireCapabilities(client)
					const typeName = capabilities.typeNames[type]

					if (!typeName) {
						throw new Error(
							`${CONTEXT}: the capabilities document names no qualified type for ${type}, so it could not be requested`
						)
					}

					return await harvestSKInspireType(client, {
						outputDir: options.outRoot(SLUG, type),
						typeName,
						type,
						pageCap: capabilities.countDefault,
						pageSize,
						maxPages: options.maxPages,
						signal: options.signal,
						report,
					})
				},
			},
			report
		)

		summary.fetched += typeSummary.fetched
		summary.skipped += typeSummary.skipped
		summary.failed += typeSummary.failed
		summary.failedCodes.push(...typeSummary.failedCodes.map((code) => `${SLUG}/${code}`))
	}

	return summary
}
