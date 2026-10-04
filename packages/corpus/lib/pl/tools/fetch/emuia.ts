/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Harvests Poland's INSPIRE Addresses (AD) theme into the GML file that
 * `#pl/adapters/emuia/adapter` reads.
 *
 * Główny Urząd Geodezji i Kartografii publishes the Państwowy Rejestr Granic through MapServer at
 * {@linkcode PL_EMUIA_WFS}. Its dataset record states one condition of use in `otherConstraints`,
 * `Brak warunków dostępu i użytkowania` — no conditions for access and use — which the
 * address-source register elected. No license instrument is named, so the publisher's own words are
 * the label, and that statement grants the reproduction a paged harvest performs.
 *
 * `#tools/fetch/wfs-harvest` owns the page read, the appending, the manifest and the resumption.
 * What is particular to Poland is five measurements, taken on 2026-10-02:
 *
 * 1. `ms:AD.Address` is the only feature type the service publishes, and the payload is the Polish
 *    register's own schema with every address value inline, so the harvest takes that one type and
 *    resolves no reference.
 * 2. The service serves GML and no JSON. Its `GetFeature` `outputFormat` parameter advertises four
 *    values — `application/gml+xml; version=3.2`, `text/xml; subtype=gml/3.2.1`, `text/xml;
 *    subtype=gml/3.1.1` and `text/xml; subtype=gml/2.1.2` — and answers with
 *    `text/xml; subtype="gml/3.2.1"`.
 * 3. A page holds at most 1,000 features whatever `count` asks for. `count=5000` answers
 *    `numberReturned="1000"`, and the capabilities document states `CountDefault` as 1000. The page
 *    size is therefore the service's cap rather than a choice, and a full harvest is one request per
 *    thousand features.
 * 4. The service states no count of its own. `resultType=hits` answers `numberMatched="1000"` both
 *    bare and at `startIndex=1`, which is that same cap, and a feature page answers
 *    `numberMatched="unknown"`. `readCheckedWFSFeatureCount` proves a reported count against a page
 *    of the type, and a count equal to the page cap passes that check because no page can exceed the
 *    cap — a 10-feature probe agrees with 1000. `statedFeatureCount` refuses a count equal to the
 *    advertised `CountDefault` for that reason, so this service is harvested with no count and the
 *    harvest ends on the first page that returns no features. The size is read from the service when
 *    a caller asks for it, by `countWFSFeaturesByPaging`, and no count is written into this file.
 * 5. The service honors a sort. `ImplementsSorting` is `TRUE`, `sortBy=ms:id` answers HTTP 200 and
 *    `sortBy=ms:id D` returns the register's last rows first, which proves the parameter is applied.
 *    `PagingIsTransactionSafe` is `FALSE`, which is the service stating that a paged sequence may
 *    shift under edits made while it is being read. The sort bounds that shift to the rows whose
 *    `ms:id` changed rather than leaving the whole sequence unordered.
 *
 * A measurement by paging rests on monotone presence: that an index holding a feature implies every
 * smaller index holds one. A WFS offers no such guarantee, and a bisection over a service where it
 * fails reports the first gap rather than the extent. The figure is therefore reported with the date
 * it was taken, never stored as a constant: the register recorded 8,625,921 on 2026-10-01, and on
 * 2026-10-02 `startIndex=8626950` returned one feature while `startIndex=8626951` returned none, so
 * the service then held 8,626,951. That is 1,030 more than the day before, which is ordinary
 * business for a municipal address register.
 *
 * At 1,000 features per page and 1,607,180 bytes per page, a full harvest at that size is 8,627
 * requests and about 13.9 GB.
 *
 * The harvest assembles one GML document rather than one file per page, because the adapter opens
 * `opts.inputPath` as a single markup stream. The first page's root tag opens the file with its
 * namespace declarations kept and its per-page `numberReturned`, `numberMatched` and `timeStamp`
 * dropped, since those describe one page and the manifest records them per page. The closing tag is
 * written when the harvest reaches the end of the type, so a partial harvest is an unclosed document
 * — which the adapter's scanner still reads member by member, and which a resumed run appends to
 * after truncating back to the last page boundary.
 */

import { countWFSFeaturesByPaging, readCheckedWFSFeatureCount, type APIClient } from "@mailwoman/core/api"
import type { PathBuilderLike } from "path-ts"

import type { BaseFetchOptions, FetchSummary } from "#tools/fetch/download"
import { readWFSCapabilities, type WFSCapabilities } from "#tools/fetch/inspire-addresses"
import {
	collectionOpeningTag,
	harvestPagedWFS,
	runWFSHarvest,
	readWFSMarkupPage,
	rootContent,
	statedFeatureCount,
	type FeatureCountStatement,
	type HarvestedPayload,
	type WFSHarvestManifest,
} from "#tools/fetch/wfs-harvest"

/**
 * The service this module harvests.
 */
export const PL_EMUIA_WFS = "https://mapy.geoportal.gov.pl/wss/service/INSPIRE/Addresses"

/**
 * The one feature type the service publishes, spelled as its capabilities document spells it.
 */
export const PL_EMUIA_TYPE_NAME = "ms:AD.Address"

/**
 * The output format the harvest asks for, which is the first the service advertises.
 */
export const PL_EMUIA_OUTPUT_FORMAT = "application/gml+xml; version=3.2"

/**
 * The property the pages are ordered by.
 */
export const PL_EMUIA_SORT_BY = "ms:id"

/**
 * Features per page.
 *
 * The service's own cap rather than a choice: `count=5000` answers with 1,000 features,
 * and the capabilities document states `CountDefault` as 1000.
 */
export const PL_EMUIA_PAGE_SIZE = 1000

/**
 * The file the adapter's `inputPath` points at, inside the harvest directory.
 */
export const PL_EMUIA_HARVEST_FILE = "address.gml"

/**
 * The XML declaration the assembled document opens with.
 *
 * The service's own pages declare UTF-8, and the harvest is written as UTF-8.
 */
const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>\n'

/**
 * The adapter slug this module fetches for, and the directory it writes under.
 */
const SLUG = "emuia"

/**
 * Names the service in every refusal this module raises.
 */
const CONTEXT = "pl emuia wfs"

/**
 * The terms the address-source register elected for this publisher.
 */
const LICENSE = "Brak warunków dostępu i użytkowania"

/**
 * The spacing between requests.
 *
 * The service answers a 1,000-feature page in about 2 seconds and a page at a deep `startIndex`
 * in about 6, so its own latency already spaces a serial harvest further apart than this.
 * The interval is the ceiling a run is held to rather than the rate it achieves, and one
 * request per second against a government host whose terms state no rate is the ceiling chosen.
 */
const MIN_REQUEST_INTERVAL_MS = 1000

export interface HarvestEMUiAOptions {
	/**
	 * Where the harvest is written.
	 *
	 * The adapter reads {@linkcode PL_EMUIA_HARVEST_FILE} inside it.
	 */
	outputDir: PathBuilderLike
	/**
	 * Features per page, capped at {@linkcode PL_EMUIA_PAGE_SIZE} because the service caps it there.
	 */
	pageSize?: number
	/**
	 * Stop once the manifest holds this many pages, for a probe rather than a full harvest.
	 */
	maxPages?: number
	/**
	 * Measure the service's extent by paging before the harvest starts.
	 *
	 * Off by default.
	 * The measurement costs about 2·log2(n) requests — 51 for a register of this size — and the
	 * harvest does not need it: paging to the first empty page reads the type whole either way.
	 *
	 * It buys a denominator for the progress lines and a figure for the manifest,
	 * and it rests on the monotone-presence assumption this module's header states.
	 */
	measureCount?: boolean
	signal?: AbortSignal
	report?: (line: string) => void
}

/**
 * The count the service states, with how it was obtained.
 *
 * The service states none that can be used, so this reports why rather than
 * carrying its page cap forward as a count.
 * A caller that asked for {@linkcode HarvestEMUiAOptions.measureCount} gets the
 * paged measurement instead, with the requests it cost.
 */
export async function readEMUiAFeatureCount(
	client: Pick<APIClient, "fetch">,
	options: { measureCount?: boolean; pageCap: number | null }
): Promise<FeatureCountStatement> {
	const stated = statedFeatureCount(
		await readCheckedWFSFeatureCount(client, {
			wfsURL: PL_EMUIA_WFS,
			typeNames: PL_EMUIA_TYPE_NAME,
			context: CONTEXT,
		}),
		options.pageCap
	)

	if (stated.count !== null) return stated

	if (!options.measureCount) {
		return {
			count: null,
			because: `${stated.because}, and the harvest ends on the first page that returns no features`,
		}
	}

	const measured = await countWFSFeaturesByPaging(client, {
		wfsURL: PL_EMUIA_WFS,
		typeNames: PL_EMUIA_TYPE_NAME,
		outputFormat: PL_EMUIA_OUTPUT_FORMAT,
		context: CONTEXT,
	})

	return {
		count: measured.count,
		because: `${stated.because}, so the extent was measured by paging in ${measured.requests} requests, ${measured.confirmed ? "confirmed by a page straddling the last index" : "unconfirmed by the straddling page, which returned fewer features than the count implies"}, and the measurement assumes that an index holding a feature implies every smaller index holds one`,
	}
}

/**
 * What the service states about itself, with the three claims this harvest depends on checked.
 *
 * The type name and the output format are read from the document rather than taken
 * from this file's constants, so a service that stops publishing either raises here
 * instead of producing a harvest of something else.
 *
 * @throws When the service publishes no Addresses type, does not advertise the GML
 * format the adapter reads, or does not advertise result paging.
 */
export async function readEMUiACapabilities(client: Pick<APIClient, "fetch">): Promise<WFSCapabilities> {
	const capabilities = await readWFSCapabilities(client, { wfsURL: PL_EMUIA_WFS, context: CONTEXT })

	if (!capabilities.typeNames.Address) {
		throw new Error(
			`${CONTEXT}: the capabilities document publishes no Addresses feature type, so ${PL_EMUIA_TYPE_NAME} could not be confirmed`
		)
	}

	if (!capabilities.outputFormats.includes(PL_EMUIA_OUTPUT_FORMAT)) {
		throw new Error(
			`${CONTEXT}: the service does not advertise ${PL_EMUIA_OUTPUT_FORMAT}, which is the format the adapter reads — it advertises ${capabilities.outputFormats.join(", ")}`
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
 * Harvests the service into `options.outputDir` and writes the manifest beside the data file.
 *
 * @returns The manifest as written.
 */
export async function harvestEMUiAPL(
	client: Pick<APIClient, "fetch">,
	options: HarvestEMUiAOptions
): Promise<WFSHarvestManifest> {
	const capabilities = await readEMUiACapabilities(client)
	const typeName = capabilities.typeNames.Address ?? PL_EMUIA_TYPE_NAME

	const featureCount = await readEMUiAFeatureCount(client, {
		measureCount: options.measureCount,
		pageCap: capabilities.countDefault,
	})

	options.report?.(`  Feature count: ${featureCount.count ?? "not stated"} — ${featureCount.because}`)

	return harvestPagedWFS({
		context: CONTEXT,
		source: SLUG,
		outputDir: options.outputDir,
		filename: PL_EMUIA_HARVEST_FILE,
		request: {
			wfsURL: PL_EMUIA_WFS,
			typeName,
			outputFormat: PL_EMUIA_OUTPUT_FORMAT,
			sortBy: PL_EMUIA_SORT_BY,
		},
		license: LICENSE,
		// The elected statement names no attribution clause.
		// Crediting GUGiK stays good practice.
		attribution: "",
		featureCount,
		pageSize: Math.min(options.pageSize ?? PL_EMUIA_PAGE_SIZE, PL_EMUIA_PAGE_SIZE),
		maxPages: options.maxPages,
		signal: options.signal,
		report: options.report,
		readPage: async ({ startIndex, count }): Promise<HarvestedPayload> => {
			const page = await readWFSMarkupPage(client, {
				wfsURL: PL_EMUIA_WFS,
				context: CONTEXT,
				params: {
					typeNames: typeName,
					outputFormat: PL_EMUIA_OUTPUT_FORMAT,
					sortBy: PL_EMUIA_SORT_BY,
					count: String(count),
					startIndex: String(startIndex),
				},
			})

			return {
				payload: rootContent(page.body, page.root, CONTEXT),
				header: `${XML_DECLARATION}${collectionOpeningTag(page.root)}`,
				footer: `</${page.root.name}>\n`,
				numberReturned: page.numberReturned,
				numberMatched: page.numberMatched,
				retrievedAt: page.timeStamp,
			}
		},
	})
}

export type FetchEMUiAPLOptions = BaseFetchOptions &
	Pick<HarvestEMUiAOptions, "maxPages" | "measureCount" | "pageSize" | "signal"> & {
		/**
		 * An injected client, for a test that supplies its own transport.
		 */
		client?: Pick<APIClient, "fetch">
	}

/**
 * Harvests Poland's addresses under `<outRoot>/emuia/`, for `mailwoman corpus fetch emuia-pl`.
 *
 * Re-runnable: a complete harvest whose file still hashes to the manifest's digest makes
 * no request, and an interrupted one resumes at the page after the last that reached disk.
 */
export async function fetchEMUiAPL(
	options: FetchEMUiAPLOptions,
	report?: (line: string) => void
): Promise<FetchSummary> {
	// The service caps a page at 1,000, so a larger request is answered with 1,000 either way
	// and the manifest records what was asked for rather than what arrived.
	const pageSize = Math.min(options.pageSize ?? PL_EMUIA_PAGE_SIZE, PL_EMUIA_PAGE_SIZE)

	return runWFSHarvest(
		{
			slug: SLUG,
			outRoot: options.outRoot,
			filename: PL_EMUIA_HARVEST_FILE,
			expect: { wfsURL: PL_EMUIA_WFS, sortBy: PL_EMUIA_SORT_BY, pageSize },
			displayName: "pl-emuia",
			minRequestIntervalMs: MIN_REQUEST_INTERVAL_MS,
			client: options.client,
			maxPages: options.maxPages,
			harvest: async (client) =>
				harvestEMUiAPL(client, {
					outputDir: options.outRoot(SLUG),
					pageSize,
					maxPages: options.maxPages,
					measureCount: options.measureCount,
					signal: options.signal,
					report,
				}),
		},
		report
	)
}
