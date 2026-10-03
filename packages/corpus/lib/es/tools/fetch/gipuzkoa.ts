/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Downloads the INSPIRE Addresses theme the Diputación Foral de Gipuzkoa publishes for the whole
 *   province.
 *
 *   ## One feed, one entry, one archive
 *
 *   The ATOM download service at `https://b5m.gipuzkoa.eus/inspire/download/addresses.xml` holds a
 *   single entry covering the province rather than one entry per municipality, so the resolution is
 *   one request:
 *
 *       addresses.xml  →  GML/ES.GFA.AD.zip
 *
 *   That entry links its dataset through `rel="alternate"`. It carries no `rel="enclosure"` link at
 *   all, and the `rel="describedby"` link beside the alternate is the ISO 19139 metadata record. A
 *   reader that looks for an enclosure therefore finds no dataset here, and a reader that takes the
 *   first link of any relation downloads the metadata record instead of 7,959,103 bytes of
 *   addresses. {@linkcode resolveGipuzkoaArchive} asks for the alternate by name.
 *
 *   ## The entry's `<updated>` is not a freshness signal
 *
 *   The entry states `<updated>2017-01-01T08:08:00Z</updated>` while the archive it links was last
 *   modified 2026-08-08, and the entry's own summary states a weekly refresh. The feed's value has
 *   therefore not moved across at least one refresh, so comparing it against a recorded copy would
 *   keep one archive forever. The archive's HTTP `last-modified` is the signal this fetcher compares,
 *   and {@linkcode gipuzkoaPublicationIsRecorded} requires the publisher to state one before it
 *   agrees to skip a download. The feed's value is recorded beside it, unused, because it is what
 *   the publisher says about the dataset.
 *
 *   ## Why the archive stays compressed
 *
 *   `#es/adapters/gipuzkoa/adapter` reads the member through `inspireGMLChunks`, which inflates from
 *   the archive. The member `ES.GFA.AD.gml` is 313,162,472 bytes against the archive's 7,959,103, so
 *   unpacking it here would cost 39 times the disk for no reader that wants it.
 */

import { APIClient, assertNoOGCServiceException } from "@mailwoman/core/api"
import { ByteFormatter } from "@mailwoman/core/fs/formatters"
import { tryStat } from "@mailwoman/core/fs/readers"
import { makeDirectories } from "@mailwoman/core/fs/writers"
import { sha256File } from "@mailwoman/core/hash"
import { PathBuilder, type PathBuilderLike } from "path-ts"

import { ES_GIPUZKOA_ADAPTER_ID } from "#es/adapters/gipuzkoa/adapter"
import { feedChunks, linkWithRel, readAtomFeed } from "#tools/fetch/atom"
import type { BaseFetchOptions, FetchSummary, SourceManifest } from "#tools/fetch/download"
import { downloadToFile, readManifest, writeManifest } from "#tools/fetch/download"

/**
 * The ATOM download service for the province's Addresses theme.
 */
export const ES_GIPUZKOA_SERVICE_URL = "https://b5m.gipuzkoa.eus/inspire/download/addresses.xml"

/**
 * The name the archive is written under, which is what the adapter's `inputPath` states.
 */
export const ES_GIPUZKOA_ARCHIVE_FILENAME = "ES.GFA.AD.zip"

/**
 * The attribution the publisher's own `<rights>` element requires, quoted as the English feed writes it.
 *
 * The feed's subtitle states the same requirement under the publisher's Basque
 * name, `Gipuzkoako Foru Aldundia`.
 */
export const ES_GIPUZKOA_ATTRIBUTION = "«© Gipuzkoa Provincial Council»"

const SLUG = ES_GIPUZKOA_ADAPTER_ID

/**
 * What one run recorded.
 *
 * `last_modified` is the header the download was decided on.
 * `feed_updated` is the entry's own `<updated>`, recorded rather than compared,
 * because this publisher's value has not moved since 2017.
 */
export interface GipuzkoaManifest extends SourceManifest {
	service_url: string
	last_modified: string | null
	feed_updated: string | null
	attribution: string
}

/**
 * Per-invocation options.
 */
export interface DownloadGipuzkoaOptions {
	outputDir: PathBuilderLike
	/**
	 * Downloads the archive even where the publisher reports the recorded `last-modified`.
	 */
	force?: boolean
	retries?: number
	retryDelayMs?: number
	signal?: AbortSignal
	report?: (line: string) => void
}

/**
 * Where the archive is, and what the feed states about the entry that links it.
 */
export interface GipuzkoaArchiveReference {
	archiveURL: string
	/**
	 * The entry's title, which states the theme rather than a municipality.
	 */
	entryTitle: string
	/**
	 * The entry's own `<updated>`, or `null` where the entry states none.
	 */
	feedUpdated: string | null
}

/**
 * Resolves the download service to the one archive its single entry links.
 *
 * Raises where the feed lists no entry, and where the entry carries no `rel="alternate"` link.
 * The alternative would return `{fetched: 0, skipped: 0, failed: 0}`, which a caller
 * reads as a fetch that completed and found the publisher empty.
 *
 * Separate from {@linkcode downloadGipuzkoa} because the resolution is the part a test can drive.
 * The download runs on global `fetch`, which a unit test cannot intercept.
 */
export async function resolveGipuzkoaArchive(
	client: Pick<APIClient, "fetch">,
	options: { signal?: AbortSignal; report?: (line: string) => void } = {}
): Promise<GipuzkoaArchiveReference> {
	const { report } = options

	report?.(`=== ${SLUG}: reading ${ES_GIPUZKOA_SERVICE_URL}`)

	const { data: feedXML } = await client.fetch<string>({
		method: "GET",
		url: ES_GIPUZKOA_SERVICE_URL,
		responseType: "text",
		timeout: 120_000,
		signal: options.signal,
	})

	assertNoOGCServiceException(String(feedXML), `${SLUG} download service`)

	const feed = await readAtomFeed(feedChunks(String(feedXML)))
	const entry = feed.entries[0]

	if (!entry) {
		throw new Error(
			`${SLUG}: ${ES_GIPUZKOA_SERVICE_URL} holds no <entry>, so the archive covering the province ` +
				`could not be resolved.`
		)
	}

	// The alternate by name rather than the entry's first link: the `describedby` link beside it
	// addresses the ISO 19139 record, and downloading that would store metadata under a `.zip` name.
	const link = linkWithRel(entry.links, "alternate")

	if (!link?.href) {
		throw new Error(
			`${SLUG}: the entry titled "${entry.title}" carries no rel="alternate" link, so its dataset ` +
				`could not be resolved. Its links are ` +
				`${entry.links.length ? entry.links.map((each) => `${each.rel || "no rel"}=${each.href}`).join(", ") : "absent"}.`
		)
	}

	report?.(`  archive: ${link.href}`)

	return {
		archiveURL: link.href,
		entryTitle: entry.title,
		feedUpdated: entry.updated || null,
	}
}

/**
 * What the publisher's HEAD response states about the archive it holds.
 *
 * Both fields read `null` where the header is absent, rather than an empty string or zero.
 * An absent `last-modified` is the service declining to state a version, which is a
 * different fact from a version that happens to match the one on disk.
 */
export interface GipuzkoaPublication {
	lastModified: string | null
	reportedBytes: number | null
}

/**
 * Reads the publisher's HEAD response for one archive URL.
 *
 * Separate from {@linkcode downloadGipuzkoa} for the same reason {@linkcode resolveGipuzkoaArchive}
 * is: this request carries the whole freshness decision.
 */
export async function readGipuzkoaPublication(
	client: Pick<APIClient, "fetch">,
	archiveURL: string,
	options: { signal?: AbortSignal } = {}
): Promise<GipuzkoaPublication> {
	const head = await client.fetch<unknown>({
		method: "HEAD",
		url: archiveURL,
		timeout: 120_000,
		signal: options.signal,
	})

	const headers = head.headers as Record<string, string> | undefined
	const reported = Number(headers?.["content-length"] ?? Number.NaN)

	return {
		lastModified: String(headers?.["last-modified"] ?? "") || null,
		reportedBytes: Number.isFinite(reported) ? reported : null,
	}
}

/**
 * Whether the archive on disk is the one the publisher now serves.
 *
 * A publisher that states no `last-modified` answers false.
 * Comparing an absent header against an absent recorded value makes `null === null` hold,
 * and that reading keeps a stale archive for as long as the service stays silent.
 */
export function gipuzkoaPublicationIsRecorded(
	recorded: GipuzkoaManifest,
	bytesOnDisk: number,
	publication: GipuzkoaPublication
): boolean {
	if (publication.lastModified === null) return false

	return recorded.last_modified === publication.lastModified && recorded.bytes === bytesOnDisk
}

/**
 * Resolves the feed to its one archive and downloads it unless the publisher's
 * `last-modified` and the file on disk already agree with the manifest.
 */
export async function downloadGipuzkoa(
	client: Pick<APIClient, "fetch">,
	options: DownloadGipuzkoaOptions
): Promise<FetchSummary> {
	const { report } = options
	const destDir = PathBuilder.from(options.outputDir)
	const archivePath = destDir(ES_GIPUZKOA_ARCHIVE_FILENAME)
	const manifestPath = destDir("MANIFEST.json")

	// Resolved before the directory is made, so a publisher that answers with an
	// exception report leaves no empty source directory behind.
	const { archiveURL, feedUpdated } = await resolveGipuzkoaArchive(client, {
		signal: options.signal,
		report,
	})

	const publication = await readGipuzkoaPublication(client, archiveURL, { signal: options.signal })

	report?.(
		`  HEAD: ${publication.reportedBytes === null ? "no content-length" : ByteFormatter.formatIEC(publication.reportedBytes)}` +
			`, last-modified ${publication.lastModified ?? "unstated"}`
	)

	await makeDirectories(destDir)

	const recorded = await readManifest<GipuzkoaManifest>(manifestPath)
	const stat = await tryStat(archivePath)

	if (!options.force && recorded && stat && gipuzkoaPublicationIsRecorded(recorded, stat.size, publication)) {
		report?.(`  present, and the publisher's last-modified is unchanged`)

		return { fetched: 0, skipped: 1, failed: 0, failedCodes: [] }
	}

	const { bytes } = await downloadToFile({
		url: archiveURL,
		dest: archivePath,
		retries: options.retries,
		retryDelayMs: options.retryDelayMs,
		report,
	})

	const sha256 = await sha256File(archivePath)

	report?.(`  ✓ ${ByteFormatter.formatIEC(bytes)}  sha256=${sha256}`)

	const manifest: GipuzkoaManifest = {
		source_url: archiveURL,
		service_url: ES_GIPUZKOA_SERVICE_URL,
		filename: ES_GIPUZKOA_ARCHIVE_FILENAME,
		bytes,
		sha256,
		last_modified: publication.lastModified,
		feed_updated: feedUpdated,
		attribution: ES_GIPUZKOA_ATTRIBUTION,
		downloaded_at: new Date().toISOString(),
	}

	await writeManifest(manifestPath, manifest)

	report?.(`  MANIFEST written to ${manifestPath}`)

	return { fetched: 1, skipped: 0, failed: 0, failedCodes: [] }
}

/**
 * The path `#es/adapters/gipuzkoa/adapter` reads, given the root a fetch wrote under.
 */
export function esGipuzkoaInputPath(outRoot: BaseFetchOptions["outRoot"]): PathBuilderLike {
	return outRoot(SLUG, ES_GIPUZKOA_ARCHIVE_FILENAME)
}

/**
 * Per-invocation options for the registry entry.
 */
export interface FetchESGipuzkoaOptions extends BaseFetchOptions {
	force?: boolean
	retries?: number
	retryDelayMs?: number
	signal?: AbortSignal
}

/**
 * The registry entry.
 */
export async function fetchESGipuzkoa(
	options: FetchESGipuzkoaOptions,
	report?: (line: string) => void
): Promise<FetchSummary> {
	await using client = new APIClient({ displayName: SLUG, retry: true })

	// Awaited rather than returned: `await using` disposes the client when this scope exits,
	// and a disposed `APIClient` refuses every later request.
	return await downloadGipuzkoa(client, {
		outputDir: options.outRoot(SLUG),
		force: options.force,
		retries: options.retries,
		retryDelayMs: options.retryDelayMs,
		signal: options.signal,
		report,
	})
}
