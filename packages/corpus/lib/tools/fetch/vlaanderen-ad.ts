/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Harvests the INSPIRE Addresses (AD) theme of agentschap Digitaal Vlaanderen into the directory
 * that `#be/adapters/vlaanderen/adapter` reads.
 *
 * `./inspire-addresses.ts` owns what every INSPIRE WFS shares, in GeoJSON. This module is Flanders'
 * own GML paging, kept apart for three reasons the service forced:
 *
 * 1. The component types are small enough to take whole — 167,218 `ad:ThoroughfareName`, 1,190
 *    `ad:PostalDescriptor`, 609 `ad:AdminUnitName` — so the harvest writes one file per type and the
 *    adapter joins locally rather than resolving four references per address against 4,563,062 of
 *    them.
 * 2. `sortBy=gml:identifier` answers HTTP 504, so the service grants no ordering. The manifest
 *    records the pages taken and their order. That record makes a harvest reproducible even though
 *    a second harvest need not match the first.
 * 3. A bare `resultType=hits` answers `numberMatched="10000"` whatever `count` asks for. The count
 *    has to be taken past index 0: `startIndex=1` answers `numberMatched="4563062"`, and the
 *    bisected tail agrees — `startIndex=4563061` returns one feature and `startIndex=4563062`
 *    returns none.
 *
 * Article 3 of the elected `Modellicentie voor gratis hergebruik Vlaanderen` grants reproduction and
 * transmission, and article 6 states that access is free. Those two grants cover paging. The
 * capabilities document's `ows:Fees` and `ows:AccessConstraints` describe the service rather than
 * the data, so neither is read here.
 */

import { open } from "node:fs/promises"

import { APIClient } from "@mailwoman/core/api"
import { makeDirectories, writeLocalJSONFile, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { rootAttribute } from "@mailwoman/core/html/document"
import { PathBuilder, type PathBuilderLike } from "path-ts"
import { Globerator } from "spliterator/node/fs"

import { VLAANDEREN_ADAPTER_ID, type VlaanderenHarvest } from "#be/adapters/vlaanderen/adapter"
import type { BaseFetchOptions, FetchSummary } from "#tools/fetch/download"
import { readWFSMarkupPage, WFS_VERSION } from "#tools/fetch/wfs-harvest"

/**
 * The service this module harvests.
 */
export const VLAANDEREN_AD_WFS = "https://geo.api.vlaanderen.be/ad/wfs"

/**
 * The `outputFormat` the harvest is written in.
 *
 * GML is the format whose `ad:component/@xlink:href` the adapter reads.
 * `application/json` holds the same references under `@href` and serves the same lost characters,
 * so the choice is a matter of which reader the adapter uses rather than of what the service knows.
 */
const OUTPUT_FORMAT = "application/gml+xml; version=3.2"

/**
 * The largest page the service will serve.
 *
 * A `count=50000` request answers with 10,000 features, so asking for more costs
 * a request and returns the same body.
 */
export const MAX_PAGE_SIZE = 10_000

/**
 * The component feature types a harvest takes, and the file-name stem each is written under.
 *
 * Every type is paged, `ad:PostalDescriptor` and `ad:AdminUnitName` included.
 * Measured 2026-10-02, `ad:ThoroughfareName` holds 167,218 features against a 10,000 page cap,
 * so it needs 17 pages, while the other two hold 1,190 and 609 and fit in one.
 *
 * A single file for the small ones would leave the harvester correct only
 * until one of them passed the cap.
 */
const COMPONENT_STEMS = {
	ThoroughfareName: "thoroughfare-name",
	PostalDescriptor: "postal-descriptor",
	AdminUnitName: "admin-unit-name",
} as const

/**
 * One of the component feature types.
 */
type ComponentType = keyof typeof COMPONENT_STEMS

/**
 * One `GetFeature` response, with what its root element states about itself.
 */
export interface FeaturePageBody {
	body: string
	/**
	 * The `numberReturned` the root states, or `null` where it states none.
	 */
	numberReturned: number | null
	/**
	 * The `numberMatched` the root states, or `null` where it answers `unknown`.
	 *
	 * Every results page of this service answers `unknown`, so only a `resultType=hits`
	 * request past index 0 yields a number.
	 */
	numberMatched: number | null
}

/**
 * Issues one `GetFeature` against the service.
 *
 * `#tools/fetch/wfs-harvest` owns the request, the exception check and the counts.
 * Every markup-serving WFS in this directory shares them.
 * This states the service and its context.
 *
 * @throws When the service answers an OGC exception report, so a 400 carrying
 * `ows:ExceptionCode/NoApplicableCode` raises rather than being written into the harvest as a page.
 */
export async function readVlaanderenPage(
	client: Pick<APIClient, "fetch">,
	params: Readonly<Record<string, string>>
): Promise<FeaturePageBody> {
	const page = await readWFSMarkupPage(client, { wfsURL: VLAANDEREN_AD_WFS, context: "vlaanderen ad wfs", params })

	return { body: page.body, numberReturned: page.numberReturned, numberMatched: page.numberMatched }
}

/**
 * The number of features a type holds, asked past index 0.
 *
 * @throws When the service states no count, so a missing count never reads as zero features.
 */
export async function readVlaanderenFeatureCount(client: Pick<APIClient, "fetch">, typeName: string): Promise<number> {
	// `startIndex` is what makes the count a count: without it the service answers its 10000 cap.
	const page = await readVlaanderenPage(client, { typeNames: typeName, resultType: "hits", startIndex: "1" })

	if (page.numberMatched === null) {
		throw new Error(
			`vlaanderen ad wfs: a hits request for ${typeName} at startIndex=1 stated no numberMatched, ` +
				`so the type's size is unknown rather than zero`
		)
	}

	// `numberMatched` counts the whole query rather than the page, so the skipped first feature is
	// included: `ad:Address` answers 4563062 here, and `startIndex=4563062` returns no feature.
	return page.numberMatched
}

export interface HarvestVlaanderenOptions {
	/**
	 * Where the harvest is written.
	 * The adapter reads this same directory.
	 */
	outputDir: PathBuilderLike
	/**
	 * Stop after this many address pages, for a probe rather than a full harvest.
	 */
	maxPages?: number
	/**
	 * Features per address page, capped at {@link MAX_PAGE_SIZE}.
	 *
	 * This sizes the address pages only.
	 * A probe lowers it to take a small page without also splitting `ad:ThoroughfareName`
	 * into 167,218 / `pageSize` requests.
	 */
	pageSize?: number
	/**
	 * Features per component page, capped at {@link MAX_PAGE_SIZE} and defaulting to it.
	 *
	 * Only a test lowers this.
	 * A component type is always taken whole, so a smaller page yields only more requests.
	 */
	componentPageSize?: number
	signal?: AbortSignal
}

/**
 * Harvests the service into `options.outputDir` and writes the manifest the adapter reads.
 *
 * The component types are taken first and whole, so a harvest that stops early
 * holds address pages whose references all resolve.
 * Addresses first would leave every page unjoinable.
 *
 * @returns The manifest as written.
 */
/**
 * How much of a page is read to find its root attributes.
 *
 * `numberReturned` sits on the `wfs:FeatureCollection` element that opens the document.
 * A page of this service is about 20 MB, and reading all of one to find an attribute in
 * its first kilobyte would cost 1.6 GB of reads across a whole-region harvest.
 */
const PAGE_ROOT_PREFIX_BYTES = 8192

/**
 * One page a previous run wrote, as the resume reads it back.
 */
interface PageOnDisk {
	file: string
	numberReturned: number
}

/**
 * The pages a previous run left in the output directory, keyed by their `startIndex`.
 *
 * `stem` is the file-name prefix a page group writes under: `address` for the addresses,
 * and each component type's own stem.
 * A whole-region harvest writes 457 address pages and 17 thoroughfare-name pages,
 * and re-requesting either group costs the same bytes again.
 *
 * The feature count is read from each file's own `numberReturned` rather than assumed
 * from the page size, so a page the service answered short is recorded as short.
 * A file whose opening bytes state no `numberReturned` is left out. The harvest
 * then requests that index again: a page of unknown extent is not a page this
 * harvest can count, and a run killed mid-write leaves exactly that.
 *
 * A group small enough for one page is written under `<stem>.gml` with no index,
 * so that name reads as `startIndex` 0.
 */
async function pagesOnDisk(root: PathBuilder, stem: string): Promise<Map<number, PageOnDisk>> {
	const pages = new Map<number, PageOnDisk>()
	const files = await Globerator.from(`${stem}*.gml`, { cwd: root.toString(), absolute: false }).toArray()
	const indexed = new RegExp(`^${stem}(?:-(\\d+))?\\.gml$`, "u")

	for (const file of files) {
		const name = String(file)
		const matched = indexed.exec(name)

		if (!matched) continue

		const startIndex = matched[1] === undefined ? 0 : Number(matched[1])

		if (!Number.isInteger(startIndex)) continue

		const handle = await open(root(name).toString(), "r")

		try {
			const buffer = Buffer.alloc(PAGE_ROOT_PREFIX_BYTES)
			const { bytesRead } = await handle.read(buffer, 0, PAGE_ROOT_PREFIX_BYTES, 0)

			const returned = rootAttribute(buffer.subarray(0, bytesRead).toString("utf8"), "numberReturned", {
				xml: true,
			})

			if (returned === undefined || !/^\d+$/u.test(returned)) continue

			pages.set(startIndex, { file: name, numberReturned: Number(returned) })
		} finally {
			await handle.close()
		}
	}

	return pages
}

export async function harvestVlaanderenAD(
	client: Pick<APIClient, "fetch">,
	options: HarvestVlaanderenOptions
): Promise<VlaanderenHarvest> {
	const root = PathBuilder.from(options.outputDir)
	const pageSize = Math.min(options.pageSize ?? MAX_PAGE_SIZE, MAX_PAGE_SIZE)
	const componentPageSize = Math.min(options.componentPageSize ?? MAX_PAGE_SIZE, MAX_PAGE_SIZE)

	await makeDirectories(root)

	const componentFiles: Record<ComponentType, string[]> = {
		ThoroughfareName: [],
		PostalDescriptor: [],
		AdminUnitName: [],
	}

	for (const [typeName, stem] of Object.entries(COMPONENT_STEMS) as [ComponentType, string][]) {
		const count = await readVlaanderenFeatureCount(client, `ad:${typeName}`)
		const existing = await pagesOnDisk(root, stem)
		let read = 0

		for (let startIndex = 0; startIndex < count; startIndex += componentPageSize) {
			const held = existing.get(startIndex)

			if (held !== undefined) {
				componentFiles[typeName].push(held.file)
				read += held.numberReturned

				continue
			}

			const page = await readVlaanderenPage(client, {
				typeNames: `ad:${typeName}`,
				count: String(componentPageSize),
				startIndex: String(startIndex),
			})

			if (page.numberReturned === null) {
				throw new Error(
					`vlaanderen ad wfs: the ad:${typeName} page at startIndex=${startIndex} stated no ` +
						`numberReturned, so what it holds is unknown rather than empty`
				)
			}

			if (page.numberReturned === 0) break

			const file = count <= componentPageSize ? `${stem}.gml` : `${stem}-${String(startIndex).padStart(10, "0")}.gml`

			await writeLocalTextFile(page.body, root(file))

			componentFiles[typeName].push(file)
			read += page.numberReturned
		}

		// A component type read short leaves every address referencing its tail unjoinable,
		// and the adapter would refuse those rows as if the publisher had not published them.
		if (read !== count) {
			throw new Error(
				`vlaanderen ad wfs: ad:${typeName} answered ${read} features over ` +
					`${componentFiles[typeName].length} ` +
					`pages where its hits request stated ${count}, so the type was not read whole`
			)
		}
	}

	const addressCount = await readVlaanderenFeatureCount(client, "ad:Address")
	const addressPages: Array<{ startIndex: number; file: string; numberReturned: number }> = []
	let retrievedAt = ""

	// A page already on disk is not requested again.
	// The service answered HTTP 400 on one page of a whole-region harvest after 105 pages
	// and 1.8 GB, and that page answered 200 on a later attempt, so the refusal was transient.
	// Without this the next run starts at index 0 and re-downloads every page it already holds.
	// The page record is kept per page rather than written once at the end, because `harvest.json`
	// is what states which pages exist and a throw before the end leaves no record of them.
	const onDisk = await pagesOnDisk(root, "address")

	for (let startIndex = 0; startIndex < addressCount; startIndex += pageSize) {
		if (options.signal?.aborted) break

		if (options.maxPages !== undefined && addressPages.length >= options.maxPages) break

		const existing = onDisk.get(startIndex)

		if (existing !== undefined) {
			addressPages.push({ startIndex, file: existing.file, numberReturned: existing.numberReturned })

			continue
		}

		const page = await readVlaanderenPage(client, {
			typeNames: "ad:Address",
			count: String(pageSize),
			startIndex: String(startIndex),
		})

		if (page.numberReturned === null) {
			throw new Error(
				`vlaanderen ad wfs: the page at startIndex=${startIndex} stated no numberReturned, so what it ` +
					`holds is unknown rather than empty`
			)
		}

		if (page.numberReturned === 0) break

		const file = `address-${String(startIndex).padStart(10, "0")}.gml`

		await writeLocalTextFile(page.body, root(file))

		addressPages.push({ startIndex, file, numberReturned: page.numberReturned })

		retrievedAt = rootAttribute(page.body, "timeStamp", { xml: true }) ?? retrievedAt
	}

	const harvest: VlaanderenHarvest = {
		service: VLAANDEREN_AD_WFS,
		wfsVersion: WFS_VERSION,
		outputFormat: OUTPUT_FORMAT,
		retrievedAt,
		addressCount,
		components: componentFiles,
		addressPages,
	}

	await writeLocalJSONFile(harvest, root("harvest.json"))

	return harvest
}

/**
 * The directory `#be/adapters/vlaanderen/adapter` reads, given the root a fetch wrote under.
 *
 * The adapter reads the directory rather than one file, because a harvest writes the addresses
 * and each component type as separate documents beside `harvest.json`.
 */
export function vlaanderenInputPath(outRoot: BaseFetchOptions["outRoot"]): PathBuilderLike {
	return outRoot(VLAANDEREN_ADAPTER_ID)
}

/**
 * Per-invocation options for the registry entry.
 */
export interface FetchVlaanderenOptions extends BaseFetchOptions {
	maxPages?: number
	pageSize?: number
	componentPageSize?: number
	signal?: AbortSignal
}

/**
 * The registry entry.
 *
 * `harvestVlaanderenAD` takes a client so a test can drive it against stubbed bodies.
 * This supplies the client the registry's callers expect, and reports the harvest as a
 * {@linkcode FetchSummary}: one harvest is one fetched unit whatever the page count,
 * because the adapter reads the directory rather than any single page.
 */
export async function fetchVlaanderenAD(
	options: FetchVlaanderenOptions,
	report?: (line: string) => void
): Promise<FetchSummary> {
	await using client = new APIClient({ displayName: VLAANDEREN_ADAPTER_ID, retry: true })

	const outputDir = options.outRoot(VLAANDEREN_ADAPTER_ID)

	report?.(`=== ${VLAANDEREN_ADAPTER_ID}: harvesting ${VLAANDEREN_AD_WFS}`)

	// Awaited rather than returned: `await using` disposes the client when this scope exits,
	// and a disposed `APIClient` refuses every later request.
	const harvest = await harvestVlaanderenAD(client, {
		outputDir,
		maxPages: options.maxPages,
		pageSize: options.pageSize,
		componentPageSize: options.componentPageSize,
		signal: options.signal,
	})

	report?.(
		`  ✓ ${harvest.addressCount} addresses over ${harvest.addressPages.length} pages, ` +
			`components ${Object.entries(harvest.components)
				.map(([type, files]) => `${type}=${files.length}`)
				.join(" ")}`
	)

	return { fetched: 1, skipped: 0, failed: 0, failedCodes: [] }
}
