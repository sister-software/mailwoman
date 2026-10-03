/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Downloads the INSPIRE Addresses theme the Service public de Wallonie publishes for the Walloon
 *   Region.
 *
 *   ## Two feeds and one archive
 *
 *   The service document lists one dataset feed, and that feed offers one archive for the whole
 *   region rather than one per municipality. Czechia's ČÚZK publishes 6,258 archives through the same
 *   INSPIRE pattern, so the resolution here is the same shape with a list of one:
 *
 *       AD_Service.xml  →  AD_Dataset_<uuid>.xml  →  AD.Addresses.gml.zip
 *
 *   The service document's `<updated>` is the freshness signal this fetcher records. A dataset feed
 *   that reports the same value as the manifest means the archive on disk is the one the publisher
 *   serves, and the download is skipped.
 *
 *   ## Why the archive stays compressed
 *
 *   `#be/adapters/wallonie/adapter` reads the member through `inspireGMLChunks`, which inflates from
 *   the archive. The member is 5,163,917,131 bytes against the archive's 106,665,832, so unpacking it
 *   here would cost 48 times the disk for no reader that wants it.
 */

import { APIClient, assertNoOGCServiceException } from "@mailwoman/core/api"
import { ByteFormatter } from "@mailwoman/core/fs/formatters"
import { tryStat } from "@mailwoman/core/fs/readers"
import { makeDirectories } from "@mailwoman/core/fs/writers"
import { sha256File } from "@mailwoman/core/hash"
import { PathBuilder, type PathBuilderLike } from "path-ts"

import { WALLONIE_ADAPTER_ID } from "#be/adapters/wallonie/adapter"
import { feedChunks, linkWithRel, readAtomFeed } from "#tools/fetch/atom"
import type { BaseFetchOptions, FetchSummary, SourceManifest } from "#tools/fetch/download"
import { downloadToFile, readManifest, writeManifest } from "#tools/fetch/download"

/**
 * The ATOM service document, which lists the region's one dataset feed.
 */
export const BE_WALLONIE_SERVICE_URL = "https://geoservices.wallonie.be/inspire/atom/AD_Service.xml"

/**
 * The name the archive is written under, which is what the adapter's `inputPath` states.
 */
export const BE_WALLONIE_ARCHIVE_FILENAME = "AD.Addresses.gml.zip"

/**
 * The attribution the publisher's own licence statement requires, quoted as it writes it.
 */
export const BE_WALLONIE_ATTRIBUTION = "Service public de Wallonie (SPW)"

const SLUG = WALLONIE_ADAPTER_ID

/**
 * What one run recorded.
 *
 * `feed_updated` is the dataset feed's own `<updated>`.
 * A later run downloads again when that value changes, which is what the INSPIRE
 * pattern offers in place of an HTTP validator.
 */
export interface WallonieManifest extends SourceManifest {
	service_url: string
	dataset_feed_url: string
	feed_updated: string | null
	attribution: string
}

/**
 * Per-invocation options.
 */
export interface DownloadWallonieOptions {
	outputDir: PathBuilderLike
	/**
	 * Downloads the archive even where the dataset feed reports the recorded `<updated>`.
	 */
	force?: boolean
	retries?: number
	retryDelayMs?: number
	signal?: AbortSignal
	report?: (line: string) => void
}

/**
 * Where the archive is, and what the publisher states about its freshness.
 */
export interface WallonieArchiveReference {
	archiveURL: string
	datasetFeedURL: string
	/**
	 * The archive entry's own `<updated>`, or `null` where the feed states none.
	 *
	 * `updated` sits on an Atom entry rather than on the feed, so this reads the
	 * entry that carried the archive link.
	 * Wallonia's feed reported `2025-12-11` when this reader was written.
	 */
	feedUpdated: string | null
}

/**
 * Resolves the service document to the one archive it leads to, through the dataset feed it lists.
 *
 * Raises where the service document lists no dataset feed, or where that feed offers no archive.
 * The alternative would return `{fetched: 0, skipped: 0, failed: 0}`, which a caller
 * reads as a fetch that completed and found the publisher empty.
 *
 * Separate from {@linkcode downloadWallonie} because the resolution is the part a test can drive.
 * The download runs on global `fetch`, which a unit test cannot intercept.
 */
export async function resolveWallonieArchive(
	client: Pick<APIClient, "fetch">,
	options: { signal?: AbortSignal; report?: (line: string) => void } = {}
): Promise<WallonieArchiveReference> {
	const { report } = options

	report?.(`=== ${SLUG}: reading ${BE_WALLONIE_SERVICE_URL}`)

	const { data: serviceXML } = await client.fetch<string>({
		url: BE_WALLONIE_SERVICE_URL,
		timeout: 120_000,
		signal: options.signal,
	})

	assertNoOGCServiceException(String(serviceXML), `${SLUG} service document`)

	const service = await readAtomFeed(feedChunks(String(serviceXML)))

	const datasetLink = service.entries.flatMap((entry) => {
		const link = linkWithRel(entry.links, "alternate")

		return link ? [link] : []
	})[0]

	if (!datasetLink) {
		throw new Error(
			`${SLUG}: the service document lists no dataset feed through a rel="alternate" link, ` +
				`so no archive can be resolved. It listed ${service.entries.length} entries.`
		)
	}

	report?.(`  dataset feed: ${datasetLink.href}`)

	const { data: datasetXML } = await client.fetch<string>({
		url: datasetLink.href,
		timeout: 120_000,
		signal: options.signal,
	})

	assertNoOGCServiceException(String(datasetXML), `${SLUG} dataset feed`)

	const dataset = await readAtomFeed(feedChunks(String(datasetXML)))

	const offered = dataset.entries.flatMap((entry) => {
		const link = linkWithRel(entry.links, "enclosure") ?? linkWithRel(entry.links, "alternate")

		return link ? [{ entry, link }] : []
	})[0]

	if (!offered) {
		throw new Error(
			`${SLUG}: the dataset feed offers no archive through a rel="enclosure" or rel="alternate" ` +
				`link. It listed ${dataset.entries.length} entries.`
		)
	}

	return {
		archiveURL: offered.link.href,
		datasetFeedURL: datasetLink.href,
		feedUpdated: offered.entry.updated || null,
	}
}

/**
 * Resolves the service document to its one archive and downloads it.
 */
export async function downloadWallonie(
	client: Pick<APIClient, "fetch">,
	options: DownloadWallonieOptions
): Promise<FetchSummary> {
	const { report } = options
	const destDir = PathBuilder.from(options.outputDir)
	const archivePath = destDir(BE_WALLONIE_ARCHIVE_FILENAME)
	const manifestPath = destDir("MANIFEST.json")

	// Resolved before the directory is made, so a publisher that answers with an
	// exception report leaves no empty source directory behind.
	const { archiveURL, datasetFeedURL, feedUpdated } = await resolveWallonieArchive(client, {
		signal: options.signal,
		report,
	})

	await makeDirectories(destDir)

	const recorded = await readManifest<WallonieManifest>(manifestPath)
	const stat = await tryStat(archivePath)

	if (!options.force && recorded && stat && feedUpdated !== null && recorded.feed_updated === feedUpdated) {
		report?.(`  present, and the dataset feed reports the recorded updated ${feedUpdated}`)

		return { fetched: 0, skipped: 1, failed: 0, failedCodes: [] }
	}

	report?.(`  archive: ${archiveURL}`)

	const { bytes } = await downloadToFile({
		url: archiveURL,
		dest: archivePath,
		retries: options.retries,
		retryDelayMs: options.retryDelayMs,
		report,
	})

	const sha256 = await sha256File(archivePath)

	report?.(`  ✓ ${ByteFormatter.formatIEC(bytes)}  sha256=${sha256}`)

	const manifest: WallonieManifest = {
		source_url: archiveURL,
		service_url: BE_WALLONIE_SERVICE_URL,
		dataset_feed_url: datasetFeedURL,
		filename: BE_WALLONIE_ARCHIVE_FILENAME,
		bytes,
		sha256,
		feed_updated: feedUpdated,
		attribution: BE_WALLONIE_ATTRIBUTION,
		downloaded_at: new Date().toISOString(),
	}

	await writeManifest(manifestPath, manifest)

	report?.(`  MANIFEST written to ${manifestPath}`)

	return { fetched: 1, skipped: 0, failed: 0, failedCodes: [] }
}

/**
 * The path `#be/adapters/wallonie/adapter` reads, given the root a fetch wrote under.
 */
export function wallonieInputPath(outRoot: BaseFetchOptions["outRoot"]): PathBuilderLike {
	return outRoot(SLUG, BE_WALLONIE_ARCHIVE_FILENAME)
}

/**
 * Per-invocation options for the registry entry.
 */
export interface FetchWallonieOptions extends BaseFetchOptions {
	force?: boolean
	retries?: number
	retryDelayMs?: number
	signal?: AbortSignal
}

/**
 * The registry entry.
 */
export async function fetchWallonie(
	options: FetchWallonieOptions,
	report?: (line: string) => void
): Promise<FetchSummary> {
	await using client = new APIClient({ displayName: SLUG, retry: true })

	// Awaited rather than returned: `await using` disposes the client when this scope exits,
	// and a disposed `APIClient` refuses every later request.
	return await downloadWallonie(client, {
		outputDir: options.outRoot(SLUG),
		force: options.force,
		retries: options.retries,
		retryDelayMs: options.retryDelayMs,
		signal: options.signal,
		report,
	})
}
