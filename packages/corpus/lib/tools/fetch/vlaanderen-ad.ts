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
 *    records the pages taken and their order, which is what makes a harvest reproducible even though
 *    a second harvest need not match the first.
 * 3. A bare `resultType=hits` answers `numberMatched="10000"` whatever `count` asks for. The count
 *    has to be taken past index 0: `startIndex=1` answers `numberMatched="4563062"`, and the
 *    bisected tail agrees — `startIndex=4563061` returns one feature and `startIndex=4563062`
 *    returns none.
 *
 * Article 3 of the elected `Modellicentie voor gratis hergebruik Vlaanderen` grants reproduction and
 * transmission, which is what paging performs, and article 6 states that access is free. The
 * capabilities document's `ows:Fees` and `ows:AccessConstraints` describe the service rather than
 * the data, so neither is read here.
 */

import type { APIClient } from "@mailwoman/core/api"
import { makeDirectories, writeLocalJSONFile, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { rootAttribute } from "@mailwoman/core/html/document"
import { PathBuilder, type PathBuilderLike } from "path-ts"

import type { VlaanderenHarvest } from "#be/adapters/vlaanderen/adapter"
import { readWFSMarkupPage, WFS_VERSION } from "#tools/fetch/wfs-harvest"

/**
 * The service this module harvests.
 */
export const VLAANDEREN_AD_WFS = "https://geo.api.vlaanderen.be/ad/wfs"

/**
 * The `outputFormat` the harvest is written in.
 *
 * GML is the format whose `ad:component/@xlink:href` the adapter reads.
 * `application/json` carries the same references under `@href` and serves the same lost characters,
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
 * Writing the small ones as a single file would leave the harvester correct only
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
 * `#tools/fetch/wfs-harvest` owns the request, the exception check and the counts,
 * which every markup-serving WFS in this directory shares.
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
	 * A component type is always taken whole, so a smaller page buys requests alone.
	 */
	componentPageSize?: number
	signal?: AbortSignal
}

/**
 * Harvests the service into `options.outputDir` and writes the manifest the adapter reads.
 *
 * The component types are taken first and whole, so a harvest that stops early
 * holds address pages whose references all resolve.
 * Taking addresses first would leave every page unjoinable.
 *
 * @returns The manifest as written.
 */
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
		let read = 0

		for (let startIndex = 0; startIndex < count; startIndex += componentPageSize) {
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

	for (let startIndex = 0; startIndex < addressCount; startIndex += pageSize) {
		if (options.signal?.aborted) break

		if (options.maxPages !== undefined && addressPages.length >= options.maxPages) break

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
