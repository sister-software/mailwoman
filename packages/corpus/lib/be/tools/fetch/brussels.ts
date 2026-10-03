/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Downloads the INSPIRE Addresses theme Paradigm publishes for the Brussels-Capital Region.
 *
 *   ## What the publisher offers
 *
 *   One archive at a bare HTTPS URL, `URBIS_ADM_Adresses.zip`, holding a single member
 *   `UrbAdm_Adresses.gml`. Paradigm publishes no INSPIRE ATOM feed for this theme, so there is no
 *   `<updated>` element to poll and no dataset feed to resolve: the URL is the whole acquisition
 *   path. `last-modified` is the one freshness signal the service offers, and this fetcher records it
 *   in the manifest so a later run can tell a refreshed archive from the one it already holds.
 *
 *   ## Why the archive stays compressed
 *
 *   `#be/adapters/brussels/adapter` reads the member through `inspireGMLChunks`, which inflates it
 *   through the zip reader rather than from disk. The member is 474,245,978 bytes against the
 *   archive's 11,521,182, so unpacking it here would cost 41 times the disk for no reader that wants
 *   it.
 *
 *   ## Two hostnames that do not serve it
 *
 *   `urbis.brussels` and `urbisonline.brussels` both fail TLS with `ERR_TLS_CERT_ALTNAME_INVALID`,
 *   because the certificate's altnames are `*.irisnet.be` and `irisnet.be`. The services live on
 *   `irisnet.be` and the download lives on `datastore.brussels`.
 */

import { APIClient } from "@mailwoman/core/api"
import { ByteFormatter } from "@mailwoman/core/fs/formatters"
import { tryStat } from "@mailwoman/core/fs/readers"
import { makeDirectories } from "@mailwoman/core/fs/writers"
import { sha256File } from "@mailwoman/core/hash"
import { PathBuilder, type PathBuilderLike } from "path-ts"

import { BRUSSELS_ADAPTER_ID } from "#be/adapters/brussels/adapter"
import type { BaseFetchOptions, FetchSummary, SourceManifest } from "#tools/fetch/download"
import { downloadToFile, readManifest, writeManifest } from "#tools/fetch/download"

/**
 * The archive's URL, which is the whole acquisition path for this theme.
 */
export const BE_BRUSSELS_ARCHIVE_URL = "https://urbisdownload.datastore.brussels/INSPIRE/URBIS_ADM_Adresses.zip"

/**
 * The name the archive is written under, which is what the adapter's `inputPath` states.
 */
export const BE_BRUSSELS_ARCHIVE_FILENAME = "URBIS_ADM_Adresses.zip"

/**
 * The attribution CC BY 4.0 §3(a)(1) requires on a publication derived from these rows.
 */
export const BE_BRUSSELS_ATTRIBUTION = "Paradigm"

const SLUG = BRUSSELS_ADAPTER_ID

/**
 * What one run recorded, so a later run can tell a refreshed archive from the one on disk.
 *
 * `lastModified` is the publisher's own header.
 * With no ATOM feed for this theme it is the only freshness signal, and a changed
 * value is the one reason to download again.
 */
export interface BrusselsManifest extends SourceManifest {
	last_modified: string | null
	attribution: string
}

/**
 * Per-invocation options.
 */
export interface DownloadBrusselsOptions {
	outputDir: PathBuilderLike
	/**
	 * Downloads the archive even where the manifest's `lastModified` and byte count still match.
	 */
	force?: boolean
	retries?: number
	retryDelayMs?: number
	signal?: AbortSignal
	report?: (line: string) => void
}

/**
 * Downloads the archive unless the manifest and the file on disk already agree with the publisher.
 */
export async function downloadBrussels(
	client: Pick<APIClient, "fetch">,
	options: DownloadBrusselsOptions
): Promise<FetchSummary> {
	const { report } = options
	const destDir = PathBuilder.from(options.outputDir)
	const archivePath = destDir(BE_BRUSSELS_ARCHIVE_FILENAME)
	const manifestPath = destDir("MANIFEST.json")

	await makeDirectories(destDir)

	report?.(`=== ${SLUG} / ${BE_BRUSSELS_ARCHIVE_FILENAME}`)

	const head = await client.fetch<unknown>({
		method: "HEAD",
		url: BE_BRUSSELS_ARCHIVE_URL,
		timeout: 120_000,
		signal: options.signal,
	})

	const lastModified = String(head.headers?.["last-modified"] ?? "") || null
	const reportedLength = Number(head.headers?.["content-length"] ?? Number.NaN)

	report?.(
		`  HEAD: ${Number.isFinite(reportedLength) ? ByteFormatter.formatIEC(reportedLength) : "no content-length"}` +
			`, last-modified ${lastModified ?? "unstated"}`
	)

	const recorded = await readManifest<BrusselsManifest>(manifestPath)
	const stat = await tryStat(archivePath)

	if (!options.force && recorded && stat && recorded.last_modified === lastModified && recorded.bytes === stat.size) {
		report?.(`  present, and the publisher's last-modified is unchanged`)

		return { fetched: 0, skipped: 1, failed: 0, failedCodes: [] }
	}

	const { bytes } = await downloadToFile({
		url: BE_BRUSSELS_ARCHIVE_URL,
		dest: archivePath,
		retries: options.retries,
		retryDelayMs: options.retryDelayMs,
		report,
	})

	const sha256 = await sha256File(archivePath)

	report?.(`  ✓ ${ByteFormatter.formatIEC(bytes)}  sha256=${sha256}`)

	const manifest: BrusselsManifest = {
		source_url: BE_BRUSSELS_ARCHIVE_URL,
		filename: BE_BRUSSELS_ARCHIVE_FILENAME,
		bytes,
		sha256,
		last_modified: lastModified,
		attribution: BE_BRUSSELS_ATTRIBUTION,
		downloaded_at: new Date().toISOString(),
	}

	await writeManifest(manifestPath, manifest)

	report?.(`  MANIFEST written to ${manifestPath}`)

	return { fetched: 1, skipped: 0, failed: 0, failedCodes: [] }
}

/**
 * The path `#be/adapters/brussels/adapter` reads, given the root a fetch wrote under.
 */
export function brusselsInputPath(outRoot: BaseFetchOptions["outRoot"]): PathBuilderLike {
	return outRoot(SLUG, BE_BRUSSELS_ARCHIVE_FILENAME)
}

/**
 * Per-invocation options for the registry entry.
 */
export interface FetchBrusselsOptions extends BaseFetchOptions {
	force?: boolean
	retries?: number
	retryDelayMs?: number
	signal?: AbortSignal
}

/**
 * The registry entry.
 */
export async function fetchBrussels(
	options: FetchBrusselsOptions,
	report?: (line: string) => void
): Promise<FetchSummary> {
	await using client = new APIClient({ displayName: SLUG, retry: true })

	// Awaited rather than returned: `await using` disposes the client when this scope exits,
	// and a disposed `APIClient` refuses every later request.
	return await downloadBrussels(client, {
		outputDir: options.outRoot(SLUG),
		force: options.force,
		retries: options.retries,
		retryDelayMs: options.retryDelayMs,
		signal: options.signal,
		report,
	})
}
