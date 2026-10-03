/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Harvest the INSPIRE Addresses archives the Gobierno de Navarra publishes into the directory
 * `#es/adapters/navarra/adapter` reads.
 *
 * The service is one ATOM document rather than two levels. The service document at
 * `https://filescartografia.navarra.es/2_CARTOGRAFIA_TEMATICA/2_7_CATASTRO/2_7_3_INSPIRE_ATOM/2_7_3_3_AD/Addresses_ServiceATOM_Navarra.xml`
 * lists one entry per partition, and each entry links that partition's zipped GML directly.
 * Measured 2026-10-03: the document answered http 200 with 671,131 bytes holding 272 entries,
 * sha256 `6971dd61d87e2fc047e953e956b09c6cc88aaa92e16ffb3bbc4750a1edb1ab60`.
 *
 * Four properties of this service decide the harvest's shape.
 *
 * 1. **The archive link is the `enclosure` link, and the `alternate` link is not it.** Each entry
 *    carries six links, three of which address the same archive under `enclosure`, `section` and
 *    `alternate`. The entry's *first* `alternate` link is the relative href
 *    `Addresses_DatasetATOM_Navarra.xml`, which is the dataset feed, so a reader taking the first
 *    `alternate` link downloads an ATOM document in place of the archive. This harvest takes
 *    `enclosure` and refuses an entry that carries none.
 * 2. **An entry leaves its own area unstated.** Every one of the 272 entries is titled
 *    `Address Navarra` and every `<id>` is empty, so the archive's own file name,
 *    `AD_Navarra_<n>.gml.zip`, is the only statement of which partition an entry offers. The
 *    numbers are not contiguous: the 272 published partitions run from 1 to 908. A partition
 *    therefore cannot be selected by place from the feed, and this module claims no mapping from a
 *    partition number to a municipality.
 * 3. **The `length` attribute is one number repeated.** All 272 entries claim 34,987 bytes, while
 *    partition 1 delivers 7,476. Every byte count this module records is counted off the delivered
 *    body.
 * 4. **Every entry states one `<updated>`, which is also the feed's own.** All 272 read
 *    `2026-04-14T12:06:58Z`, so the value dates the publication rather than the file. It is still
 *    the freshness signal a re-run compares, because a new edition moves it. A skip requires the
 *    feed to state a value: where it states none, both sides read an empty string and an equality
 *    test would keep an archive of unknown age for as long as the feed stayed silent.
 *
 * A full harvest is 273 requests and roughly 10 MB: a systematic sample of 10 of the 272 archives
 * on 2026-10-03 ran from 7,476 to 112,830 bytes. The harvest is bound by round trips rather than by
 * bandwidth and is dispatched serially through one `APIClient` at
 * {@linkcode ES_NAVARRA_REQUEST_INTERVAL_MS}.
 *
 * The archives stay compressed. `#es/adapters/navarra/adapter` reads the GML member through
 * `inspireGMLChunks`, which inflates from the archive, and partition 1's member is 307,117 bytes
 * against its archive's 7,476.
 */

import { APIClient, assertNoOGCServiceException } from "@mailwoman/core/api"
import { ByteFormatter } from "@mailwoman/core/fs/formatters"
import { tryStat } from "@mailwoman/core/fs/readers"
import { makeDirectories } from "@mailwoman/core/fs/writers"
import { sha256File } from "@mailwoman/core/hash"
import { stringifyJSON } from "@mailwoman/core/json"
import { PathBuilder, type PathBuilderLike } from "path-ts"

import { ES_NAVARRA_ADAPTER_ID, ES_NAVARRA_LICENSE } from "#es/adapters/navarra/adapter"
import type { AtomFeed } from "#tools/fetch/atom"
import { feedChunks, linkWithRel, readAtomFeed } from "#tools/fetch/atom"
import type { BaseFetchOptions, FetchSummary, SourceCollectionManifest, SourceManifest } from "#tools/fetch/download"
import { loadCollectionFiles, writeManifest } from "#tools/fetch/download"
import { downloadZipArchive } from "#tools/fetch/zip-archive"

/**
 * The ATOM service document, which lists one zipped GML partition per entry.
 */
export const ES_NAVARRA_SERVICE_FEED_URL =
	"https://filescartografia.navarra.es/2_CARTOGRAFIA_TEMATICA/2_7_CATASTRO/2_7_3_INSPIRE_ATOM/2_7_3_3_AD/Addresses_ServiceATOM_Navarra.xml"

/**
 * The attribution the publisher's licence requires.
 *
 * Every entry's `<rights>` elects `Creative Commons Attribution 4.0 International (CC BY 4.0)`,
 * whose attribution clause requires naming the creator, so a model card carrying
 * this source credits the publisher.
 */
export const ES_NAVARRA_ATTRIBUTION = "Gobierno de Navarra"

/**
 * The minimum spacing between two requests to `filescartografia.navarra.es`, in milliseconds.
 *
 * Four requests per second against one government host.
 * The publisher states no rate limit, and a full harvest is 273 requests.
 */
export const ES_NAVARRA_REQUEST_INTERVAL_MS = 250

/**
 * The directory the harvest writes under, which is the adapter's `inputPath`.
 */
const SLUG = ES_NAVARRA_ADAPTER_ID

/**
 * How many archives are written between two manifest writes.
 *
 * The manifest is what makes an interrupted harvest resumable.
 * At this interval an interruption re-fetches at most this many archives that are already on disk.
 */
const MANIFEST_INTERVAL = 25

/**
 * A partition archive's file name, `AD_Navarra_1.gml.zip`.
 */
const ARCHIVE_FILENAME = /^AD_Navarra_(\d+)\.gml\.zip$/iu

/**
 * One partition, as the service document states it.
 */
export interface ESNavarraPartition {
	/**
	 * The partition number the archive's file name states.
	 *
	 * Kept as the digits the publisher wrote rather than as a number, because it
	 * is part of a file name rather than a quantity.
	 */
	partition: string
	/**
	 * The entry's title, which reads `Address Navarra` on every entry.
	 */
	title: string
	/**
	 * The entry's `<updated>`, which dates the publication.
	 */
	updated: string
	archiveURL: string
	/**
	 * The file name the archive is written under, which is the name the publisher gave it
	 * and the name the adapter globs.
	 */
	filename: string
}

/**
 * The partitions the service document lists.
 *
 * @throws When the document holds no entry, when an entry carries no `enclosure` link, when a
 * linked archive is not named `AD_Navarra_<n>.gml.zip`, or when two entries name one archive.
 * Each of those would otherwise write zero archives while reporting a completed run.
 */
export function readESNavarraServiceFeed(feed: AtomFeed): readonly ESNavarraPartition[] {
	if (!feed.entries.length) {
		throw new Error(
			`${ES_NAVARRA_SERVICE_FEED_URL}: the service document holds no <entry>, so the partitions it offers ` +
				`could not be read`
		)
	}

	const partitions: ESNavarraPartition[] = []
	const seen = new Set<string>()

	for (const entry of feed.entries) {
		// The `enclosure` link rather than the first `alternate` link: an entry's first
		// `alternate` link is the relative dataset-feed href, and downloading it would
		// store an ATOM document under an archive's name.
		const link = linkWithRel(entry.links, "enclosure")

		if (!link?.href) {
			throw new Error(
				`${ES_NAVARRA_SERVICE_FEED_URL}: an entry titled ${stringifyJSON(entry.title)} carries no ` +
					`rel="enclosure" link, so its archive could not be read`
			)
		}

		const filename = link.href.slice(link.href.lastIndexOf("/") + 1)
		const numbered = ARCHIVE_FILENAME.exec(filename)

		if (!numbered) {
			throw new Error(
				`${ES_NAVARRA_SERVICE_FEED_URL}: an entry links ${stringifyJSON(filename)}, which is not named ` +
					`AD_Navarra_<n>.gml.zip. Every entry is titled ${stringifyJSON(entry.title)}, so the file name ` +
					`is the only statement of which partition the entry offers.`
			)
		}

		if (seen.has(filename)) {
			throw new Error(
				`${ES_NAVARRA_SERVICE_FEED_URL}: ${stringifyJSON(filename)} is listed twice, so one of the two ` +
					`archives would overwrite the other`
			)
		}

		seen.add(filename)

		partitions.push({
			partition: numbered[1]!,
			title: entry.title.trim(),
			updated: entry.updated,
			archiveURL: link.href,
			filename,
		})
	}

	return partitions
}

/**
 * One archive, as the harvest's manifest records it.
 */
export interface ESNavarraArchiveEntry extends SourceManifest {
	partition: string
	/**
	 * The `<updated>` the service document stated when this archive was fetched.
	 *
	 * A later run that reads the same value leaves the file alone.
	 * The publisher moves it when it publishes a new edition.
	 */
	feed_updated: string
	/**
	 * The `Last-Modified` the host served the archive under, or `null` where it served none.
	 */
	last_modified: string | null
}

/**
 * The harvest's `MANIFEST.json`.
 */
export interface ESNavarraHarvestManifest extends SourceCollectionManifest {
	/**
	 * How many partitions the service document listed when this manifest was written.
	 *
	 * The denominator for `files`, read from the feed on each run rather than fixed here.
	 */
	partitions_listed: number
	files: ESNavarraArchiveEntry[]
}

export interface HarvestESNavarraOptions {
	/**
	 * Where the archives and the manifest are written, which is the adapter's `inputPath`.
	 */
	outputDir: PathBuilderLike
	/**
	 * Harvest only these partition numbers, for a probe or for a repair of named partitions.
	 *
	 * A number the service document does not list is reported as a failure rather than ignored.
	 */
	partitions?: readonly string[]
	/**
	 * Stop after this many partitions, counting the ones already on disk.
	 */
	limit?: number
	/**
	 * Re-read the sha256 of every archive already on disk instead of comparing its byte count.
	 *
	 * The default compares the recorded byte count against the file's size, which is one `stat`.
	 */
	verifyDigests?: boolean
	signal?: AbortSignal
	report?: (line: string) => void
}

/**
 * Whether the archive recorded for one partition is still the one the feed describes.
 *
 * A skip requires the feed to state an `<updated>` value.
 * Where it states none, both sides read an empty string and an equality test would hold,
 * which would keep an archive of unknown age for as long as the feed stayed silent.
 */
async function isCurrent(
	recorded: ESNavarraArchiveEntry | undefined,
	partition: ESNavarraPartition,
	path: PathBuilderLike,
	verifyDigests: boolean
): Promise<boolean> {
	if (!recorded || !partition.updated || recorded.feed_updated !== partition.updated) return false

	const stat = await tryStat(path)

	if (!stat || stat.size !== recorded.bytes) return false

	// The digest check reads the whole file rather than its metadata, which is why it is opt-in.
	if (!verifyDigests) return true

	return (await sha256File(path)) === recorded.sha256
}

/**
 * The partitions this run considers, and the numbers a caller named that the feed does not list.
 *
 * A number the caller asked for and the service document does not list is returned
 * rather than dropped, because a partition that is not published is a different
 * condition from a selection that holds no partition.
 */
function selectPartitions(
	listed: readonly ESNavarraPartition[],
	options: Pick<HarvestESNavarraOptions, "partitions" | "limit">
): { selected: readonly ESNavarraPartition[]; unknown: readonly string[] } {
	let selected = listed
	const unknown: string[] = []

	if (options.partitions) {
		const byNumber = new Map(listed.map((partition) => [partition.partition, partition]))
		const found: ESNavarraPartition[] = []

		for (const number of options.partitions) {
			const partition = byNumber.get(number)

			if (partition) {
				found.push(partition)
			} else {
				unknown.push(number)
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
 * Harvest the partitions the service document lists into `options.outputDir`.
 *
 * The client is injected so the harvest is testable without the network and so a caller decides
 * the pacing. {@linkcode fetchESNavarra} is the registry entry point and supplies both.
 *
 * @returns What was fetched, what the feed states is already recorded, and which partitions failed.
 * @throws When the service document lists no partition, which would otherwise answer
 * `{fetched: 0, skipped: 0, failed: 0}` and read to a caller as a completed fetch of an empty publisher.
 */
export async function harvestESNavarra(
	client: Pick<APIClient, "fetch">,
	options: HarvestESNavarraOptions
): Promise<FetchSummary> {
	const { report, signal } = options
	const destDir = PathBuilder.from(options.outputDir)
	const manifestPath = destDir("MANIFEST.json")

	report?.(`=== ${SLUG}: reading ${ES_NAVARRA_SERVICE_FEED_URL}`)

	const { data: serviceXML } = await client.fetch<string>({
		method: "GET",
		url: ES_NAVARRA_SERVICE_FEED_URL,
		responseType: "text",
		timeout: 120_000,
		signal,
	})

	// The service document shares the http 200 an exception report arrives on.
	assertNoOGCServiceException(serviceXML, `${SLUG} service document`)

	const feed = await readAtomFeed(feedChunks(serviceXML))
	const listed = readESNavarraServiceFeed(feed)

	report?.(`  ${listed.length} partitions listed`)

	const wanted = selectPartitions(listed, options)

	report?.(`  ${wanted.selected.length} selected for this run`)

	// Resolved before the directory is made, so a publisher that answers an exception
	// report leaves no empty source directory behind.
	await makeDirectories(destDir)

	const previous = await loadCollectionFiles(manifestPath)
	const files = new Map<string, ESNavarraArchiveEntry>()

	// An entry for a partition this run does not consider is carried through,
	// so a bounded run never drops what an earlier run recorded.
	for (const [filename, entry] of previous) {
		files.set(filename, entry as ESNavarraArchiveEntry)
	}

	let fetched = 0
	let skipped = 0
	const failedCodes: string[] = [...wanted.unknown]

	for (const unknown of wanted.unknown) {
		report?.(`  ✗ partition ${unknown} is not listed in the service document`)
	}

	const writeHarvestManifest = async (): Promise<void> => {
		const manifest: ESNavarraHarvestManifest = {
			source: SLUG,
			source_url: ES_NAVARRA_SERVICE_FEED_URL,
			license: ES_NAVARRA_LICENSE,
			attribution: ES_NAVARRA_ATTRIBUTION,
			downloaded_at: new Date().toISOString(),
			partitions_listed: listed.length,
			files: [...files.values()].toSorted((left, right) => Number(left.partition) - Number(right.partition)),
		}

		await writeManifest(manifestPath, manifest)
	}

	for (const partition of wanted.selected) {
		if (signal?.aborted) break

		const dest = destDir(partition.filename)

		if (await isCurrent(files.get(partition.filename), partition, dest, options.verifyDigests ?? false)) {
			skipped++

			continue
		}

		try {
			const delivered = await downloadZipArchive(client, {
				url: partition.archiveURL,
				dest,
				timeout: 600_000,
				signal,
			})

			files.set(partition.filename, {
				partition: partition.partition,
				filename: partition.filename,
				source_url: partition.archiveURL,
				downloaded_at: new Date().toISOString(),
				sha256: delivered.sha256,
				bytes: delivered.bytes,
				feed_updated: partition.updated,
				last_modified: delivered.lastModified,
			})

			fetched++

			report?.(`  ✓ ${partition.filename} ${ByteFormatter.formatIEC(delivered.bytes)} sha256=${delivered.sha256}`)
		} catch (error) {
			report?.(`  ✗ ${partition.partition}: ${error instanceof Error ? error.message : String(error)}`)
			failedCodes.push(partition.partition)

			continue
		}

		if (fetched % MANIFEST_INTERVAL === 0) {
			await writeHarvestManifest()
		}
	}

	await writeHarvestManifest()

	report?.(`=== ${SLUG} summary`)
	report?.(`fetched: ${fetched}`)
	report?.(`skipped: ${skipped} (the feed states the publication date already recorded)`)
	report?.(`failed:  ${failedCodes.length}`)

	return { fetched, skipped, failed: failedCodes.length, failedCodes }
}

/**
 * The path `#es/adapters/navarra/adapter` reads, given the root a fetch wrote under.
 *
 * The adapter takes one archive or a directory holding them, and a harvest writes a directory.
 */
export function esNavarraInputPath(outRoot: BaseFetchOptions["outRoot"]): PathBuilderLike {
	return outRoot(SLUG)
}

export interface FetchESNavarraOptions
	extends BaseFetchOptions, Pick<HarvestESNavarraOptions, "partitions" | "limit" | "verifyDigests" | "signal"> {
	/**
	 * The minimum spacing between two requests, in milliseconds.
	 *
	 * Defaults to {@linkcode ES_NAVARRA_REQUEST_INTERVAL_MS}.
	 */
	minRequestIntervalMs?: number
}

/**
 * Harvest the Gobierno de Navarra's INSPIRE Addresses partitions into `<outRoot>/es-navarra/`.
 *
 * Re-runnable: a partition whose recorded publication date is still the one the feed states,
 * and whose archive is still on disk at the recorded length, costs no request.
 */
export async function fetchESNavarra(
	options: FetchESNavarraOptions,
	report?: (line: string) => void
): Promise<FetchSummary> {
	await using client = new APIClient({
		displayName: SLUG,
		minRequestIntervalMs: options.minRequestIntervalMs ?? ES_NAVARRA_REQUEST_INTERVAL_MS,
		retry: true,
	})

	// Awaited rather than returned: `await using` disposes the client when this scope exits,
	// and a disposed `APIClient` refuses every later request.
	return await harvestESNavarra(client, {
		outputDir: options.outRoot(SLUG),
		partitions: options.partitions,
		limit: options.limit,
		verifyDigests: options.verifyDigests,
		signal: options.signal,
		report,
	})
}
