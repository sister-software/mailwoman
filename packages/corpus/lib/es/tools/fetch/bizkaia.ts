/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Harvests the INSPIRE Addresses theme the Diputación Foral de Bizkaia publishes into the
 *   directory `#es/adapters/bizkaia/adapter` reads.
 *
 *   ## Two services, because the archives hold only addresses
 *
 *   The ATOM download service at `https://apli.bizkaia.eus/apps/Danok/INSPIRE/addresses.xml` lists
 *   one entry per municipality, each offering that municipality's addresses as a zipped GML through a
 *   `rel="enclosure"` link. Those archives hold no `ad:ThoroughfareName`, `ad:PostalDescriptor` or
 *   `ad:AdminUnitName` feature: every `ad:component` reference an address writes is a stored-query
 *   URL on the publisher's WFS that the ATOM service does not republish. An adapter handed only those
 *   archives therefore reads every address in the province without its street, its postcode or
 *   its municipality. This harvest acquires both services into one directory for that reason.
 *
 *   Each component type is read in one request, and that is the only way this service serves it. Its
 *   capabilities document states `ImplementsResultPaging` as `FALSE` and `CountDefault` as `1000`, so
 *   a reader that paged a type would receive the first page again. The harvest therefore asks
 *   `RESULTTYPE=hits` for the type's count and then asks for that many features in one `GetFeature`,
 *   and {@linkcode fetchBizkaiaComponentDocument} raises where the document returns fewer than the
 *   count. A truncated component document is the failure that would otherwise reach the adapter as
 *   an unresolved reference per address.
 *
 *   A component document's own bytes are not reproducible. Its `wfs:FeatureCollection` holds a
 *   `timeStamp` attribute holding the moment of the request, so two identical harvests differ in
 *   that element and therefore in their digests. The manifest records each document's byte count and
 *   sha256 as what arrived, never as a value a later run compares against.
 *
 *   ## What decides a skip
 *
 *   The service document states one `<updated>`, repeated on all of its entries, rather than a
 *   modification time per municipality: the 112 entries served on 2026-10-03 all read
 *   `2026-10-01T02:40:20Z`, which is the feed document's own modification time. One request therefore
 *   states the freshness of every archive the service offers, as ČÚZK's does, and a re-run requests
 *   only the municipalities whose archive is missing or no longer the recorded length. Whether that
 *   value moves whenever an archive is replaced is inferred from one observation rather than
 *   established: on 2026-10-03 the feed read `2026-10-01T02:40:20Z` and `ES.BFA.AD.001.zip` was
 *   served with `Last-Modified: Thu, 01 Oct 2026 00:01:15 GMT`. Each archive's own `last-modified` is
 *   recorded beside its entry so a later run can check that inference against the record.
 *
 *   The component documents state no version at all. The WFS answers them under `Cache-Control:
 *   no-cache` with no `Last-Modified`, so a run holds no value to compare and every run that
 *   harvests them downloads them again. {@linkcode HarvestESBizkaiaOptions.components} is how a run that wants
 *   only the archives declines the 14 MB.
 */

/* oxlint-disable sister-software/prefer-region-over-marks -- these markers label steps inside one
   procedure rather than sections of declarations. A region there folds no element a reader wants folded. */

import { APIClient, assertNoOGCServiceException, readWFSFeatureCount } from "@mailwoman/core/api"
import { ByteFormatter } from "@mailwoman/core/fs/formatters"
import { tryStat } from "@mailwoman/core/fs/readers"
import { makeDirectories, writeLocalFile } from "@mailwoman/core/fs/writers"
import { sha256File, sha256Hex } from "@mailwoman/core/hash"
import { rootAttribute } from "@mailwoman/core/html/document"
import { stringifyJSON } from "@mailwoman/core/json"
import { PathBuilder, type PathBuilderLike } from "path-ts"

import { ES_BIZKAIA_ADAPTER_ID, ES_BIZKAIA_LICENSE } from "#es/adapters/bizkaia/adapter"
import type { AtomFeed } from "#tools/fetch/atom"
import { feedChunks, linkWithRel, readAtomFeed } from "#tools/fetch/atom"
import type { BaseFetchOptions, FetchSummary, SourceCollectionManifest, SourceManifest } from "#tools/fetch/download"
import { loadCollectionFiles, readManifest, writeManifest } from "#tools/fetch/download"
import { downloadZipArchive } from "#tools/fetch/zip-archive"

/**
 * The ATOM download service listing one archive per municipality.
 */
export const ES_BIZKAIA_SERVICE_URL = "https://apli.bizkaia.eus/apps/Danok/INSPIRE/addresses.xml"

/**
 * The WFS the municipality archives reference their components on.
 *
 * Read from the `xlink:href` the archives themselves write.
 * That link addresses this endpoint through the `GetFeatureById` stored query.
 */
export const ES_BIZKAIA_WFS_URL =
	"https://geo.bizkaia.eus/arcgisserverinspire/rest/services/Catastro/Annex1/MapServer/exts/InspireFeatureDownload/service"

/**
 * The attribution the publisher's own `<rights>` element requires, quoted as it writes it.
 */
export const ES_BIZKAIA_ATTRIBUTION = "«©Bizkaiko Foru Aldundia»"

/**
 * The component feature types the harvest saves from the WFS.
 *
 * The four the adapter indexes.
 * `ad:AddressAreaName` is harvested although the province published none when this was written, because
 * the schema admits one and a type left unasked is indistinguishable from a type that answered empty.
 */
export const ES_BIZKAIA_COMPONENT_TYPES = [
	"ad:ThoroughfareName",
	"ad:PostalDescriptor",
	"ad:AdminUnitName",
	"ad:AddressAreaName",
] as const

/**
 * One of {@linkcode ES_BIZKAIA_COMPONENT_TYPES}.
 */
export type ESBizkaiaComponentType = (typeof ES_BIZKAIA_COMPONENT_TYPES)[number]

/**
 * The minimum spacing between two requests, in milliseconds.
 *
 * Four requests per second against one government host.
 * The publisher states no rate limit.
 */
export const ES_BIZKAIA_REQUEST_INTERVAL_MS = 250

/**
 * Per-request timeout for a body, in milliseconds.
 *
 * Ten minutes.
 * That covers both a municipality archive and the one component document with every street in the province.
 */
const BODY_TIMEOUT_MS = 600_000

/**
 * How many archives are written between two manifest writes.
 *
 * The manifest is what makes an interrupted harvest resumable, and writing it
 * after every archive would rewrite the whole document once per municipality.
 * At this interval an interruption re-fetches at most this many archives already on disk.
 */
const MANIFEST_INTERVAL = 25

/**
 * The municipality code an entry's title states, `48001-ABADIÑO Addresses` → `48001`.
 */
const TITLE_CODE = /^(\d+)\s*-/u

/**
 * The archive file name an entry's INSPIRE identifier states, `ES.BFA.AD.001.zip`.
 *
 * The identifier is the file name itself on this service rather than a dataset URN.
 */
const IDENTIFIER_FILENAME = /^(ES\.BFA\.AD\.(\d+)\.zip)$/u

/**
 * The file name a component type is written under, `ad:ThoroughfareName` → `ad-ThoroughfareName.xml`.
 *
 * The colon is replaced because the adapter globs these documents out of a directory
 * and a prefixed name is awkward to address from a shell.
 * The `.xml` extension is what puts the document inside the adapter's own glob.
 */
export function bizkaiaComponentFilename(type: string): string {
	return `${type.replace(":", "-")}.xml`
}

/**
 * One municipality's archive, as the service document states it.
 */
export interface ESBizkaiaMunicipalityDataset {
	/**
	 * The five-digit municipality code the entry's title states, `48001`.
	 */
	code: string
	/**
	 * The entry's title, `48001-ABADIÑO Addresses`.
	 */
	title: string
	/**
	 * The `<updated>` the entry states.
	 * Every entry of this service repeats the feed's own value.
	 */
	updated: string
	/**
	 * The archive's URL, as the entry's `rel="enclosure"` link writes it.
	 */
	downloadURL: string
	/**
	 * The file name the archive is written under.
	 * The adapter globs this name.
	 */
	filename: string
}

/**
 * The municipalities the service document lists.
 *
 * The file name comes from the entry's INSPIRE identifier and the municipality code from
 * its title, and the two are checked against each other, because the file name is what
 * the archive is stored under: a disagreement between the publisher's two statements of
 * a municipality would store one municipality's addresses under another's name.
 *
 * @throws When the feed lists no entry, when an entry states neither spelling of its
 * municipality, when the two spellings disagree, when two entries claim one file name
 * and one archive would overwrite the other, or when an entry has no `rel="enclosure"` link.
 */
export function readESBizkaiaServiceFeed(feed: AtomFeed): readonly ESBizkaiaMunicipalityDataset[] {
	if (!feed.entries.length) {
		throw new Error(
			`${ES_BIZKAIA_SERVICE_URL}: the service document holds no <entry>, so the municipalities it offers ` +
				`could not be read`
		)
	}

	const datasets: ESBizkaiaMunicipalityDataset[] = []
	const seen = new Set<string>()

	for (const entry of feed.entries) {
		const identified = IDENTIFIER_FILENAME.exec((entry.identifierCode ?? "").trim())
		const fromTitle = TITLE_CODE.exec(entry.title.trim())?.[1]

		if (!identified) {
			throw new Error(
				`${ES_BIZKAIA_SERVICE_URL}: the entry titled "${entry.title}" states the dataset identifier ` +
					`${stringifyJSON(entry.identifierCode)}, which is not an ES.BFA.AD.<n>.zip archive name`
			)
		}

		if (!fromTitle) {
			throw new Error(
				`${ES_BIZKAIA_SERVICE_URL}: the entry titled "${entry.title}" opens with no municipality code, ` +
					`so the archive ${identified[1]!} could not be checked against the title`
			)
		}

		// The identifier holds the three-digit tail of the five-digit municipality code:
		// `48915` is published as `ES.BFA.AD.915.zip`.
		if (!fromTitle.endsWith(identified[2]!)) {
			throw new Error(
				`${ES_BIZKAIA_SERVICE_URL}: the entry titled "${entry.title}" states municipality ${fromTitle} in its ` +
					`title and ${identified[2]!} in its archive name ${identified[1]!}, so the municipality it holds is ambiguous`
			)
		}

		const enclosure = linkWithRel(entry.links, "enclosure")

		if (!enclosure?.href) {
			throw new Error(
				`${ES_BIZKAIA_SERVICE_URL}: the entry for municipality ${fromTitle} carries no rel="enclosure" link, ` +
					`so its archive could not be read`
			)
		}

		if (seen.has(identified[1]!)) {
			throw new Error(
				`${ES_BIZKAIA_SERVICE_URL}: the archive ${identified[1]!} is listed twice, so one of the two copies ` +
					`would overwrite the other`
			)
		}

		seen.add(identified[1]!)

		datasets.push({
			code: fromTitle,
			title: entry.title.trim(),
			updated: entry.updated,
			downloadURL: enclosure.href,
			filename: identified[1]!,
		})
	}

	return datasets
}

/**
 * One municipality's archive, as the harvest's manifest records it.
 */
export interface ESBizkaiaArchiveEntry extends SourceManifest {
	municipality_code: string
	/**
	 * The `<updated>` the service document stated when this archive was fetched.
	 */
	feed_updated: string
	/**
	 * The `Last-Modified` the host served the archive under, or `null` where it served none.
	 *
	 * Recorded rather than compared.
	 * It is the record against which the service document's single `<updated>` can
	 * later be checked as a per-municipality signal.
	 */
	last_modified: string | null
}

/**
 * One saved WFS component document, as the harvest's manifest records it.
 */
export interface ESBizkaiaComponentEntry extends SourceManifest {
	type_name: string
	/**
	 * The count the service reported for this type under `RESULTTYPE=hits`.
	 */
	feature_count: number
	/**
	 * The `numberReturned` the saved document states.
	 *
	 * The harvest requires it to equal {@linkcode ESBizkaiaComponentEntry.feature_count}.
	 */
	features_returned: number
}

/**
 * The harvest's `MANIFEST.json`.
 */
export interface ESBizkaiaHarvestManifest extends SourceCollectionManifest {
	wfs_url: string
	/**
	 * The `<updated>` the service document stated on this run.
	 */
	feed_updated: string | null
	/**
	 * How many municipalities the service document listed when this manifest was written.
	 *
	 * The denominator for `files`, read from the feed on each run rather than fixed here.
	 */
	municipalities_listed: number
	files: ESBizkaiaArchiveEntry[]
	/**
	 * The saved WFS documents, kept apart from `files` because they have no
	 * municipality and no stated version.
	 */
	components: ESBizkaiaComponentEntry[]
}

export interface HarvestESBizkaiaOptions {
	/**
	 * Where the archives, the component documents and the manifest are written.
	 * This path is the adapter's `inputPath`.
	 */
	outputDir: PathBuilderLike
	/**
	 * Harvest only these five-digit municipality codes, for a probe or to repair specific ones.
	 *
	 * A code the service document does not list is reported as a failure rather than ignored.
	 */
	municipalities?: readonly string[]
	/**
	 * Stop after this many municipalities, counting the ones already on disk.
	 */
	limit?: number
	/**
	 * Save the WFS component documents as well as the archives.
	 * Defaults to true.
	 *
	 * An adapter run needs them: an archive references its street, its postcode
	 * and its municipality and has none of the three.
	 */
	components?: boolean
	/**
	 * Download every selected archive again, whatever the manifest records.
	 */
	force?: boolean
	/**
	 * Re-read the sha256 of every archive already on disk instead of comparing its byte count.
	 *
	 * The default compares the recorded byte count against the file's size, one `stat`.
	 */
	verifyDigests?: boolean
	signal?: AbortSignal
	report?: (line: string) => void
}

/**
 * Whether the archive recorded for one municipality is still the one the feed now describes.
 *
 * Three conditions: the service document states the `<updated>` it stated when the file was
 * fetched, the file is still there, and it is still the length that was recorded for it.
 * An entry stating no `<updated>` answers false rather than matching a recorded absence,
 * so a service that stops stating a version is re-fetched rather than frozen.
 */
async function archiveIsCurrent(
	recorded: ESBizkaiaArchiveEntry | undefined,
	dataset: ESBizkaiaMunicipalityDataset,
	path: PathBuilderLike,
	verifyDigests: boolean
): Promise<boolean> {
	if (!dataset.updated) return false

	if (!recorded || recorded.feed_updated !== dataset.updated) return false

	const stat = await tryStat(path)

	if (!stat || stat.size !== recorded.bytes) return false

	// The digest check reads the whole file rather than its metadata.
	// It is opt-in.
	if (!verifyDigests) return true

	return (await sha256File(path)) === recorded.sha256
}

/**
 * Reads one component feature type whole and writes it beside the archives.
 *
 * Two requests per type: `RESULTTYPE=hits` for the count, then one `GetFeature` for that many features.
 * `COUNT` is asked one above the stated count, so a service whose hits response
 * undercounts its own matches answers with more features than it claimed
 * rather than with exactly the number the harvest asked for.
 *
 * @throws When the document's `numberReturned` is missing, unreadable,
 * or not the count the service reported.
 * A document holding fewer features than the service matched would reach the adapter as
 * an unresolved component reference on every address that referenced a missing feature.
 */
export async function fetchBizkaiaComponentDocument(
	client: Pick<APIClient, "fetch">,
	typeName: string,
	options: { dest: PathBuilderLike; signal?: AbortSignal }
): Promise<ESBizkaiaComponentEntry> {
	const context = `${ES_BIZKAIA_ADAPTER_ID} WFS ${typeName}`

	const featureCount = await readWFSFeatureCount(client, {
		wfsURL: ES_BIZKAIA_WFS_URL,
		typeNames: typeName,
		context,
		subject: typeName,
	})

	const { data } = await client.fetch<string>({
		method: "GET",
		url: ES_BIZKAIA_WFS_URL,
		responseType: "text",
		timeout: BODY_TIMEOUT_MS,
		signal: options.signal,
		params: {
			service: "WFS",
			version: "2.0.0",
			request: "GetFeature",
			typeNames: typeName,
			count: String(featureCount + 1),
		},
	})

	const document = String(data)

	assertNoOGCServiceException(document, context)

	// `numberMatched` reads `unknown` on this service's feature pages, so the delivered
	// count is read from `numberReturned` and compared against the hits request's figure.
	const returned = rootAttribute(document, "numberReturned", { xml: true })

	if (returned === undefined || !/^\d+$/u.test(returned)) {
		throw new Error(
			`${context}: the GetFeature response states numberReturned=${stringifyJSON(returned ?? null)} rather than ` +
				`a count, so what the document holds against the ${featureCount} features the service matched is unknown`
		)
	}

	if (Number(returned) !== featureCount) {
		throw new Error(
			`${context}: the service matched ${featureCount} features and returned ${returned}. The document is ` +
				`therefore not the whole type, and this service advertises ImplementsResultPaging=FALSE, so the ` +
				`remainder cannot be paged.`
		)
	}

	const bytes = Buffer.from(document, "utf8")

	await writeLocalFile(bytes, options.dest)

	return {
		type_name: typeName,
		filename: PathBuilder.from(options.dest).basename(),
		source_url: `${ES_BIZKAIA_WFS_URL}?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature&TYPENAMES=${typeName}`,
		downloaded_at: new Date().toISOString(),
		sha256: sha256Hex(bytes),
		bytes: bytes.byteLength,
		feature_count: featureCount,
		features_returned: Number(returned),
	}
}

/**
 * Harvest the municipality archives and the WFS component documents into `options.outputDir`.
 *
 * The client is injected so the harvest is testable without the network and so a caller decides
 * the pacing. {@linkcode fetchESBizkaia} is the registry entry point and supplies both.
 *
 * @returns What was fetched, what was already current, and which municipality codes
 * or component types failed.
 */
export async function harvestESBizkaia(
	client: Pick<APIClient, "fetch">,
	options: HarvestESBizkaiaOptions
): Promise<FetchSummary> {
	const { report, signal } = options
	const destDir = PathBuilder.from(options.outputDir)
	const manifestPath = destDir("MANIFEST.json")

	// MARK: Read the service document
	//
	// One request, and it states the version of every archive the service offers.

	report?.(`=== ${ES_BIZKAIA_ADAPTER_ID}: reading ${ES_BIZKAIA_SERVICE_URL}`)

	const { data: serviceXML } = await client.fetch<string>({
		method: "GET",
		url: ES_BIZKAIA_SERVICE_URL,
		responseType: "text",
		timeout: 120_000,
		signal,
	})

	assertNoOGCServiceException(String(serviceXML), `${ES_BIZKAIA_ADAPTER_ID} service document`)

	const feed = await readAtomFeed(feedChunks(String(serviceXML)))
	const listed = readESBizkaiaServiceFeed(feed)

	report?.(`  ${listed.length} municipalities listed`)

	const wanted = selectMunicipalities(listed, options)

	report?.(`  ${wanted.selected.length} selected for this run`)

	await makeDirectories(destDir)

	// MARK: Fetch the archives the feed describes anew

	const previous = await loadCollectionFiles(manifestPath)
	const recordedManifest = await readManifest<ESBizkaiaHarvestManifest>(manifestPath)
	const files = new Map<string, ESBizkaiaArchiveEntry>()

	// An entry for a municipality this run does not consider is kept, so a bounded
	// run never drops what an earlier run recorded.
	for (const [filename, entry] of previous) {
		files.set(filename, entry as ESBizkaiaArchiveEntry)
	}

	const components = new Map<string, ESBizkaiaComponentEntry>()

	for (const entry of recordedManifest?.components ?? []) {
		components.set(entry.type_name, entry)
	}

	let fetched = 0
	let skipped = 0
	const failedCodes: string[] = [...wanted.unknown]

	for (const unknown of wanted.unknown) {
		report?.(`  ✗ municipality ${unknown} is not listed in the service document`)
	}

	const writeHarvestManifest = async (): Promise<void> => {
		const manifest: ESBizkaiaHarvestManifest = {
			source: ES_BIZKAIA_ADAPTER_ID,
			source_url: ES_BIZKAIA_SERVICE_URL,
			wfs_url: ES_BIZKAIA_WFS_URL,
			license: ES_BIZKAIA_LICENSE,
			attribution: ES_BIZKAIA_ATTRIBUTION,
			downloaded_at: new Date().toISOString(),
			feed_updated: listed[0]?.updated ?? null,
			municipalities_listed: listed.length,
			files: [...files.values()].toSorted((left, right) => left.filename.localeCompare(right.filename)),
			components: [...components.values()].toSorted((left, right) => left.type_name.localeCompare(right.type_name)),
		}

		await writeManifest(manifestPath, manifest)
	}

	for (const dataset of wanted.selected) {
		if (signal?.aborted) break

		const dest = destDir(dataset.filename)

		if (
			!options.force &&
			(await archiveIsCurrent(files.get(dataset.filename), dataset, dest, options.verifyDigests ?? false))
		) {
			skipped++

			continue
		}

		try {
			const entry = await fetchArchive(client, dataset, { dest, signal })

			files.set(dataset.filename, entry)

			fetched++

			report?.(`  ✓ ${dataset.code} ${ByteFormatter.formatIEC(entry.bytes)} sha256=${entry.sha256}`)
		} catch (error) {
			report?.(`  ✗ ${dataset.code}: ${error instanceof Error ? error.message : String(error)}`)
			failedCodes.push(dataset.code)

			continue
		}

		if (fetched % MANIFEST_INTERVAL === 0) {
			await writeHarvestManifest()
		}
	}

	// MARK: Save the WFS component documents
	//
	// Downloaded on every run that asks for them.
	// The service states no version to compare.

	if (options.components ?? true) {
		for (const typeName of ES_BIZKAIA_COMPONENT_TYPES) {
			if (signal?.aborted) break

			const filename = bizkaiaComponentFilename(typeName)

			try {
				const entry = await fetchBizkaiaComponentDocument(client, typeName, { dest: destDir(filename), signal })

				components.set(typeName, entry)

				fetched++

				report?.(
					`  ✓ ${typeName} ${entry.feature_count} features, ` +
						`${ByteFormatter.formatIEC(entry.bytes)} sha256=${entry.sha256}`
				)
			} catch (error) {
				report?.(`  ✗ ${typeName}: ${error instanceof Error ? error.message : String(error)}`)
				failedCodes.push(typeName)
			}
		}
	}

	await writeHarvestManifest()

	report?.(`=== ${ES_BIZKAIA_ADAPTER_ID} summary`)
	report?.(`fetched: ${fetched}`)
	report?.(`skipped: ${skipped} (the feed states the <updated> already recorded)`)
	report?.(`failed:  ${failedCodes.length}`)

	return { fetched, skipped, failed: failedCodes.length, failedCodes }
}

/**
 * The municipalities this run considers, and the codes a caller asked for that the feed does not list.
 *
 * A code the caller asked for and the service document does not list is returned
 * rather than dropped, because a municipality that is not published is a different
 * condition from a selection that holds no municipality.
 */
function selectMunicipalities(
	listed: readonly ESBizkaiaMunicipalityDataset[],
	options: Pick<HarvestESBizkaiaOptions, "municipalities" | "limit">
): { selected: readonly ESBizkaiaMunicipalityDataset[]; unknown: readonly string[] } {
	let selected = listed
	const unknown: string[] = []

	if (options.municipalities) {
		const byCode = new Map(listed.map((dataset) => [dataset.code, dataset]))
		const found: ESBizkaiaMunicipalityDataset[] = []

		for (const code of options.municipalities) {
			const dataset = byCode.get(code)

			if (dataset) {
				found.push(dataset)
			} else {
				unknown.push(code)
			}
		}

		selected = found
	}

	if (options.limit !== undefined) {
		selected = selected.slice(0, options.limit)
	}

	return { selected, unknown }
}

/**
 * Download one municipality's archive and answer the manifest entry for it.
 *
 * The transfer runs on the harvest's own client through {@linkcode downloadZipArchive},
 * which refuses a body that does not begin with a zip signature.
 */
async function fetchArchive(
	client: Pick<APIClient, "fetch">,
	dataset: ESBizkaiaMunicipalityDataset,
	options: { dest: PathBuilderLike; signal?: AbortSignal }
): Promise<ESBizkaiaArchiveEntry> {
	const delivered = await downloadZipArchive(client, {
		url: dataset.downloadURL,
		dest: options.dest,
		timeout: BODY_TIMEOUT_MS,
		signal: options.signal,
	})

	return {
		municipality_code: dataset.code,
		filename: dataset.filename,
		source_url: dataset.downloadURL,
		downloaded_at: new Date().toISOString(),
		sha256: delivered.sha256,
		bytes: delivered.bytes,
		feed_updated: dataset.updated,
		last_modified: delivered.lastModified,
	}
}

/**
 * The path `#es/adapters/bizkaia/adapter` reads, given the root a fetch wrote under.
 *
 * The directory rather than a file: the adapter reads every archive and every saved
 * WFS document under it, and the component documents hold the streets.
 */
export function esBizkaiaInputPath(outRoot: BaseFetchOptions["outRoot"]): PathBuilderLike {
	return outRoot(ES_BIZKAIA_ADAPTER_ID)
}

/**
 * Per-invocation options for the registry entry.
 */
export interface FetchESBizkaiaOptions
	extends
		BaseFetchOptions,
		Pick<HarvestESBizkaiaOptions, "municipalities" | "limit" | "components" | "force" | "verifyDigests" | "signal"> {
	/**
	 * The minimum spacing between two requests, in milliseconds.
	 *
	 * Defaults to {@linkcode ES_BIZKAIA_REQUEST_INTERVAL_MS}.
	 */
	minRequestIntervalMs?: number
}

/**
 * Harvest Bizkaia's INSPIRE Addresses into `<outRoot>/es-bizkaia/`.
 *
 * A full harvest is the service document, one request per municipality it lists,
 * and two requests per component type.
 */
export async function fetchESBizkaia(
	options: FetchESBizkaiaOptions,
	report?: (line: string) => void
): Promise<FetchSummary> {
	await using client = new APIClient({
		displayName: ES_BIZKAIA_ADAPTER_ID,
		minRequestIntervalMs: options.minRequestIntervalMs ?? ES_BIZKAIA_REQUEST_INTERVAL_MS,
		retry: true,
	})

	// Awaited rather than returned: `await using` disposes the client when this scope exits,
	// and a disposed `APIClient` refuses every later request.
	return await harvestESBizkaia(client, {
		outputDir: options.outRoot(ES_BIZKAIA_ADAPTER_ID),
		municipalities: options.municipalities,
		limit: options.limit,
		components: options.components,
		force: options.force,
		verifyDigests: options.verifyDigests,
		signal: options.signal,
		report,
	})
}
