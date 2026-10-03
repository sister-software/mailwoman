/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Downloads the INSPIRE Addresses theme Kadaster publishes for the Netherlands.
 *
 *   ## One feed and one file
 *
 *   PDOK serves an ATOM download service with a single entry, and that entry's one data link is the
 *   whole country. There is no service document above it and no dataset feed below it, so the
 *   resolution is one request:
 *
 *       adressen_inspire_geharmoniseerd.xml  →  addresses.gml.gz
 *
 *   The entry's `<id>` names a sibling feed, `adressen_inspire_geharmoniseerd_epsg4258.xml`, which
 *   answers HTTP 404. A reader that followed the `<id>` rather than the `rel="alternate"` link would
 *   therefore raise on that 404, so this one reads the link.
 *
 *   ## Why the download stays compressed
 *
 *   `#nl/adapters/kadaster/adapter` inflates `.gml.gz` through `gunzipChunks` as it streams. The
 *   member is 29,677,448,685 bytes against the download's 819,465,603, so inflating it here would
 *   cost 36 times the disk for no reader that wants it.
 *
 *   ## Freshness
 *
 *   The entry's `<updated>` is the signal recorded in the manifest. A skip requires the feed to
 *   state an `<updated>` value:
 *   where it states none both sides read `null`, an equality test would hold, and a download of
 *   unknown age would be kept for as long as the feed stayed silent.
 */

import { APIClient, assertNoOGCServiceException } from "@mailwoman/core/api"
import { ByteFormatter } from "@mailwoman/core/fs/formatters"
import { tryStat } from "@mailwoman/core/fs/readers"
import { makeDirectories } from "@mailwoman/core/fs/writers"
import { sha256File } from "@mailwoman/core/hash"
import { PathBuilder, type PathBuilderLike } from "path-ts"

import { NL_KADASTER_ADAPTER_ID, NL_KADASTER_DEFAULT_LICENSE } from "#nl/adapters/kadaster/adapter"
import { feedChunks, linkWithRel, readAtomFeed } from "#tools/fetch/atom"
import type { BaseFetchOptions, FetchSummary, SourceManifest } from "#tools/fetch/download"
import { downloadToFile, readManifest, writeManifest } from "#tools/fetch/download"

/**
 * The ATOM download service for the theme, which holds the country's one entry.
 */
export const NL_KADASTER_FEED_URL = "https://service.pdok.nl/kadaster/ad/atom/adressen_inspire_geharmoniseerd.xml"

/**
 * The name the download is written under, which is what the adapter's `inputPath` states.
 *
 * The publisher's own name for the file.
 * The adapter reads a `.gml.gz` by inflating it, so the suffix is load-bearing.
 */
export const NL_KADASTER_DOWNLOAD_FILENAME = "addresses.gml.gz"

/**
 * The attribution recorded in the manifest.
 *
 * CC0 1.0 reserves no act and owes no attribution clause, so this is the credit the
 * repository chooses to carry rather than a condition of the grant.
 */
export const NL_KADASTER_ATTRIBUTION = "Kadaster"

const SLUG = NL_KADASTER_ADAPTER_ID

/**
 * What one run recorded.
 *
 * `feed_updated` is the entry's own `<updated>`.
 * A later run downloads again when that value changes, which is what the ATOM
 * pattern offers in place of an HTTP validator.
 *
 * `rights` is the license URL the feed states, recorded so a change of terms is
 * visible in the artifact rather than only in the register.
 */
export interface NLKadasterManifest extends SourceManifest {
	feed_url: string
	feed_updated: string | null
	rights: string | null
	license: string
	attribution: string
}

/**
 * Per-invocation options.
 */
export interface DownloadNLKadasterOptions {
	outputDir: PathBuilderLike
	/**
	 * Downloads the file even where the feed reports the recorded `<updated>`.
	 */
	force?: boolean
	retries?: number
	retryDelayMs?: number
	signal?: AbortSignal
	report?: (line: string) => void
}

/**
 * Where the download is, and what the feed states about it.
 */
export interface NLKadasterPublication {
	downloadURL: string
	/**
	 * The entry's own `<updated>`, or `null` where the feed states none.
	 *
	 * `updated` sits on the Atom entry as well as on the feed, and this reads
	 * the entry that carried the data link.
	 * The feed reported `2026-09-02T11:45:47Z` when this reader was written.
	 */
	feedUpdated: string | null
	/**
	 * The entry's `<rights>`, or `null` where it states none.
	 */
	rights: string | null
	/**
	 * The byte count the link claims, or `null` where it claims none.
	 *
	 * Never taken as the size of the download: the bytes recorded in the manifest
	 * are counted off the delivered body.
	 */
	claimedBytes: number | null
}

/**
 * Reads the feed and answers the one entry's data link.
 *
 * Raises where the feed lists no entry, or where its entry offers no data link.
 * The alternative would return `{fetched: 0, skipped: 0, failed: 0}`, which a caller
 * reads as a fetch that completed and found the publisher empty.
 *
 * Separate from {@linkcode downloadNLKadaster} because the resolution is the part a test can drive.
 * The download runs on global `fetch`, which a unit test cannot intercept.
 */
export async function readNLKadasterPublication(
	client: Pick<APIClient, "fetch">,
	options: { signal?: AbortSignal; report?: (line: string) => void } = {}
): Promise<NLKadasterPublication> {
	const { report } = options

	report?.(`=== ${SLUG}: reading ${NL_KADASTER_FEED_URL}`)

	const { data: feedXML } = await client.fetch<string>({
		url: NL_KADASTER_FEED_URL,
		timeout: 120_000,
		signal: options.signal,
	})

	assertNoOGCServiceException(String(feedXML), `${SLUG} download service feed`)

	const feed = await readAtomFeed(feedChunks(String(feedXML)))

	const offered = feed.entries.flatMap((entry) => {
		const link = linkWithRel(entry.links, "enclosure") ?? linkWithRel(entry.links, "alternate")

		return link ? [{ entry, link }] : []
	})[0]

	if (!offered) {
		throw new Error(
			`${SLUG}: the feed offers no download through a rel="enclosure" or rel="alternate" link, ` +
				`so no file can be resolved. It listed ${feed.entries.length} entries.`
		)
	}

	return {
		downloadURL: offered.link.href,
		feedUpdated: offered.entry.updated || null,
		rights: offered.entry.rights,
		claimedBytes: offered.link.length,
	}
}

/**
 * Whether the file on disk is the one the feed currently offers.
 *
 * A skip requires the feed to state an `<updated>` value.
 * Where it states none, both sides read `null` and an equality test would hold,
 * which would keep a download of unknown age for as long as the feed stayed silent.
 *
 * Downloading 782 MiB again is the slower error and the recoverable one.
 */
export function nlKadasterPublicationIsRecorded(
	recorded: NLKadasterManifest,
	bytesOnDisk: number,
	publication: NLKadasterPublication
): boolean {
	if (publication.feedUpdated === null) return false

	return recorded.feed_updated === publication.feedUpdated && recorded.bytes === bytesOnDisk
}

/**
 * Resolves the feed to its one file and downloads it.
 */
export async function downloadNLKadaster(
	client: Pick<APIClient, "fetch">,
	options: DownloadNLKadasterOptions
): Promise<FetchSummary> {
	const { report } = options
	const destDir = PathBuilder.from(options.outputDir)
	const downloadPath = destDir(NL_KADASTER_DOWNLOAD_FILENAME)
	const manifestPath = destDir("MANIFEST.json")

	// Resolved before the directory is made, so a publisher that answers with an
	// exception report leaves no empty source directory behind.
	const publication = await readNLKadasterPublication(client, { signal: options.signal, report })

	await makeDirectories(destDir)

	const recorded = await readManifest<NLKadasterManifest>(manifestPath)
	const stat = await tryStat(downloadPath)

	if (!options.force && recorded && stat && nlKadasterPublicationIsRecorded(recorded, stat.size, publication)) {
		report?.(`  present, and the feed reports the recorded updated ${publication.feedUpdated}`)

		return { fetched: 0, skipped: 1, failed: 0, failedCodes: [] }
	}

	report?.(
		`  download: ${publication.downloadURL}` +
			(publication.claimedBytes === null
				? ""
				: ` (the feed claims ${ByteFormatter.formatIEC(publication.claimedBytes)})`)
	)

	const { bytes } = await downloadToFile({
		url: publication.downloadURL,
		dest: downloadPath,
		retries: options.retries,
		retryDelayMs: options.retryDelayMs,
		report,
	})

	const sha256 = await sha256File(downloadPath)

	report?.(`  ✓ ${ByteFormatter.formatIEC(bytes)}  sha256=${sha256}`)

	const manifest: NLKadasterManifest = {
		source_url: publication.downloadURL,
		feed_url: NL_KADASTER_FEED_URL,
		filename: NL_KADASTER_DOWNLOAD_FILENAME,
		bytes,
		sha256,
		feed_updated: publication.feedUpdated,
		rights: publication.rights,
		license: NL_KADASTER_DEFAULT_LICENSE,
		attribution: NL_KADASTER_ATTRIBUTION,
		downloaded_at: new Date().toISOString(),
	}

	await writeManifest(manifestPath, manifest)

	report?.(`  MANIFEST written to ${manifestPath}`)

	return { fetched: 1, skipped: 0, failed: 0, failedCodes: [] }
}

/**
 * The path `#nl/adapters/kadaster/adapter` reads, given the root a fetch wrote under.
 */
export function nlKadasterInputPath(outRoot: BaseFetchOptions["outRoot"]): PathBuilderLike {
	return outRoot(SLUG, NL_KADASTER_DOWNLOAD_FILENAME)
}

/**
 * Per-invocation options for the registry entry.
 */
export interface FetchNLKadasterOptions extends BaseFetchOptions {
	force?: boolean
	retries?: number
	retryDelayMs?: number
	signal?: AbortSignal
}

/**
 * The registry entry.
 */
export async function fetchNLKadaster(
	options: FetchNLKadasterOptions,
	report?: (line: string) => void
): Promise<FetchSummary> {
	await using client = new APIClient({ displayName: SLUG, retry: true })

	// Awaited rather than returned: `await using` disposes the client when this scope exits,
	// and a disposed `APIClient` refuses every later request.
	return await downloadNLKadaster(client, {
		outputDir: options.outRoot(SLUG),
		force: options.force,
		retries: options.retries,
		retryDelayMs: options.retryDelayMs,
		signal: options.signal,
		report,
	})
}
