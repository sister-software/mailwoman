/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Download the GLEIF Level 1 golden copy for the `gleif-lei` adapter.
 *
 * GLEIF publishes the whole LEI-CDF record set three times a day as one zipped CSV. The publish API at
 * {@linkcode GLEIF_LATEST_PUBLISH_URL} names the current file, its byte length, its record count and the
 * CDF version it follows, so this module reads that answer first and downloads the file it names.
 *
 * Three measured properties of the host decide what this module does. Measured on 2026-10-03 against the
 * `2026-10-03 08:00:00` publish:
 *
 * 1. **The API's `size` is the archive's length.** It stated 507,006,221 and the host answered a
 *    `HEAD` with `content-length` 507,006,221 and a one-byte range with `Content-Range: bytes
 *    0-9/507006221`. The transfer is checked against the API's figure, so a body cut short or a
 *    publish replaced mid-transfer is refused rather than recorded.
 * 2. **The host honors `Range`.** An interrupted transfer resumes through
 *    {@linkcode resumableDownload}. The request names `accept-encoding: identity`, because the host
 *    compresses small responses on the fly and a range must count the archive's own bytes.
 * 3. **Each publish has its own file name**, date-prefixed as
 *    `20261003-0800-gleif-goldencopy-lei2-golden-copy.csv.zip`. The archive is kept under that
 *    name, so a partial transfer of one publish never resumes into another, and the adapter reads the
 *    newest name in the directory.
 *
 * The archive is kept zipped. Its one CSV member decompresses to several gigabytes, and the adapter
 * streams the member out of the archive rather than reading an extracted copy.
 *
 * The receipt written beside the archive records the URL, the publish date, the byte count and the
 * sha256 of the archive. Together they identify the bytes a corpus row was read from.
 */

import { APIClient } from "@mailwoman/core/api"
import { ByteFormatter } from "@mailwoman/core/fs/formatters"
import { tryStat } from "@mailwoman/core/fs/readers/stat"
import { makeDirectories, removePathIfPresent } from "@mailwoman/core/fs/writers"
import { listZipEntries } from "@mailwoman/core/fs/zip"
import { sha256File } from "@mailwoman/core/hash"
import { PathBuilder, type PathBuilderLike } from "path-ts"
import { Globerator } from "spliterator/node/fs"

import {
	GLEIF_ADAPTER_ID,
	GLEIF_ARCHIVE_PATTERN,
	GLEIF_ATTRIBUTION,
	GLEIF_LICENSE,
	GLEIF_LICENSE_URL,
} from "#adapters/gleif/adapter"
import type { BaseFetchOptions, FetchSummary } from "#tools/fetch/download"
import { readManifest, resumableDownload, writeManifest } from "#tools/fetch/download"

/**
 * The publish API's answer for the newest golden copy and its delta files.
 */
export const GLEIF_LATEST_PUBLISH_URL = "https://goldencopy.gleif.org/api/v2/golden-copies/publishes/latest"

/**
 * The directory the archive and its receipt are written under.
 * It is the adapter's `inputPath`.
 */
const SLUG = "gleif"

/**
 * The file the publish API names for the Level 1 golden copy in CSV.
 */
export interface GLEIFPublishedFile {
	/**
	 * The publish timestamp the API states, as `2026-10-03 08:00:00`.
	 */
	publishDate: string
	url: string
	/**
	 * The archive's length in bytes, as the API states it.
	 */
	bytes: number
	recordCount: number
	cdfVersion: string
}

/**
 * The receipt written beside the archive.
 */
export interface GLEIFGoldenCopyReceipt {
	source: string
	source_url: string
	api_url: string
	publish_date: string
	cdf_version: string
	/**
	 * The record count the API states for this publish.
	 */
	record_count: number
	downloaded_at: string
	filename: string
	bytes: number
	sha256: string
	/**
	 * The CSV member inside the archive, and its decompressed length as the central directory states it.
	 */
	csv_member: string
	csv_member_bytes: number
	license: string
	license_url: string
	attribution: string
}

/**
 * The fields this module reads from the publish API's answer.
 */
interface PublishResponse {
	data?: {
		lei2?: {
			publish_date?: string
			full_file?: {
				csv?: { url?: string; size?: number; record_count?: number; cdf_version?: string }
			}
		}
	}
}

/**
 * Read which file the publish API names as the current Level 1 golden copy in CSV.
 *
 * @throws When the answer omits any of the five fields, naming the one it lacks,
 * rather than downloading a file whose length or date cannot be checked.
 */
export async function readGLEIFLatestPublish(client: Pick<APIClient, "fetch">): Promise<GLEIFPublishedFile> {
	const response = await client.fetch<PublishResponse>({ method: "GET", url: GLEIF_LATEST_PUBLISH_URL })
	const lei2 = response.data?.data?.lei2
	const csv = lei2?.full_file?.csv

	const fields = {
		"data.lei2.publish_date": lei2?.publish_date,
		"data.lei2.full_file.csv.url": csv?.url,
		"data.lei2.full_file.csv.size": csv?.size,
		"data.lei2.full_file.csv.record_count": csv?.record_count,
		"data.lei2.full_file.csv.cdf_version": csv?.cdf_version,
	}

	const missing = Object.entries(fields)
		.filter(([, value]) => value === undefined || value === null || value === "")
		.map(([name]) => name)

	if (missing.length) {
		throw new Error(`${GLEIF_LATEST_PUBLISH_URL} answered without ${missing.join(", ")}`)
	}

	return {
		publishDate: lei2!.publish_date!,
		url: csv!.url!,
		bytes: Number(csv!.size),
		recordCount: Number(csv!.record_count),
		cdfVersion: csv!.cdf_version!,
	}
}

/**
 * The archive's file name.
 * It is the last path segment of the URL the API returns.
 */
export function gleifArchiveFilename(url: string): string {
	const name = new URL(url).pathname.split("/").at(-1) ?? ""

	if (!GLEIF_ARCHIVE_PATTERN.test(name)) {
		throw new Error(`${url} does not name a golden-copy archive matching ${GLEIF_ARCHIVE_PATTERN}`)
	}

	return name
}

/**
 * The directory the adapter reads under a fetch root.
 */
export function gleifInputPath(outRoot: BaseFetchOptions["outRoot"]): PathBuilderLike {
	return outRoot(SLUG)
}

/**
 * Whether the archive on disk is the publish the API names and the length the receipt records.
 *
 * Exported so a test can exercise the decision without a transfer.
 */
export async function isGLEIFArchiveCurrent(
	recorded: GLEIFGoldenCopyReceipt | null,
	published: GLEIFPublishedFile,
	path: PathBuilderLike,
	verifyDigest: boolean
): Promise<boolean> {
	if (!recorded) return false

	if (recorded.source_url !== published.url || recorded.publish_date !== published.publishDate) return false

	const stat = await tryStat(path)

	if (!stat || stat.size !== recorded.bytes) return false

	if (!verifyDigest) return true

	return (await sha256File(path)) === recorded.sha256
}

export interface DownloadGLEIFOptions {
	/**
	 * Where the archive and the receipt are written.
	 * The directory itself is the adapter's `inputPath`.
	 */
	outputDir: PathBuilderLike
	/**
	 * Re-read the archive's sha256 on a re-run instead of comparing its byte count.
	 */
	verifyDigest?: boolean
	/**
	 * Download even where the receipt already records the current publish.
	 */
	force?: boolean
	retryDelayMs?: number
	report?: (line: string) => void
}

export type FetchGLEIFOptions = BaseFetchOptions & Omit<DownloadGLEIFOptions, "outputDir" | "report">

/**
 * Download the current Level 1 golden copy into `options.outputDir` and write its receipt.
 *
 * Re-runnable: a receipt naming the current publish, with the archive still on disk
 * at the recorded length, makes no request for the body.
 * Archives of earlier publishes are removed once the new one is verified,
 * so the directory holds one publish.
 */
export async function downloadGLEIF(
	client: Pick<APIClient, "fetch">,
	options: DownloadGLEIFOptions
): Promise<FetchSummary> {
	const { report } = options
	const destDir = PathBuilder.from(options.outputDir)
	const summary: FetchSummary = { fetched: 0, skipped: 0, failed: 0, failedCodes: [] }

	await makeDirectories(destDir)

	report?.(`=== ${SLUG}`)

	const published = await readGLEIFLatestPublish(client)
	const filename = gleifArchiveFilename(published.url)
	const archivePath = destDir(filename)
	const receiptPath = destDir("MANIFEST.json")

	report?.(
		`  publish ${published.publishDate}: ${published.recordCount.toLocaleString()} records, ` +
			`${ByteFormatter.formatIEC(published.bytes)}, ${published.cdfVersion}`
	)

	const recorded = await readManifest<GLEIFGoldenCopyReceipt>(receiptPath)

	if (
		!options.force &&
		(await isGLEIFArchiveCurrent(recorded, published, archivePath, options.verifyDigest ?? false))
	) {
		report?.(`  ✓ ${filename} already current — no download.`)

		summary.skipped++

		return summary
	}

	let bytes: number

	try {
		bytes = await resumableDownload({
			url: published.url,
			dest: archivePath,
			headers: { "accept-encoding": "identity", accept: "application/zip" },
			retryDelayMs: options.retryDelayMs,
			report,
		})
	} catch (error) {
		report?.(`  ✗ download failed: ${error instanceof Error ? error.message : String(error)}`)

		summary.failed++
		summary.failedCodes.push(filename)

		return summary
	}

	if (bytes !== published.bytes) {
		await removePathIfPresent(archivePath)

		report?.(`  ✗ the API stated ${published.bytes} bytes and ${bytes} arrived, so the archive is not recorded`)

		summary.failed++
		summary.failedCodes.push(filename)

		return summary
	}

	const members = (await listZipEntries(archivePath)).filter((entry) => entry.name.toLowerCase().endsWith(".csv"))

	if (members.length !== 1) {
		report?.(`  ✗ ${filename} holds ${members.length} CSV members, where the golden copy publishes one`)

		summary.failed++
		summary.failedCodes.push(filename)

		return summary
	}

	const receipt: GLEIFGoldenCopyReceipt = {
		source: GLEIF_ADAPTER_ID,
		source_url: published.url,
		api_url: GLEIF_LATEST_PUBLISH_URL,
		publish_date: published.publishDate,
		cdf_version: published.cdfVersion,
		record_count: published.recordCount,
		downloaded_at: new Date().toISOString(),
		filename,
		bytes,
		sha256: await sha256File(archivePath),
		csv_member: members[0]!.name,
		csv_member_bytes: members[0]!.uncompressedSize,
		license: GLEIF_LICENSE,
		license_url: GLEIF_LICENSE_URL,
		attribution: GLEIF_ATTRIBUTION,
	}

	await writeManifest(receiptPath, receipt)

	// The adapter reads the newest archive in the directory, so an earlier publish
	// is removed only after this one is verified and recorded.
	const earlier = await Globerator.from("*.csv.zip", { cwd: destDir.toString(), absolute: false }).toArray()

	for (const name of earlier) {
		if (name !== filename && GLEIF_ARCHIVE_PATTERN.test(name)) {
			await removePathIfPresent(destDir(name))
		}
	}

	report?.(`  ✓ ${filename}: ${ByteFormatter.formatIEC(bytes)}, sha256 ${receipt.sha256}`)
	report?.(`  MANIFEST written to ${receiptPath.toString()}`)

	summary.fetched++

	return summary
}

/**
 * Download the current golden copy into `<outRoot>/gleif/`.
 *
 * The registry entry point.
 * The adapter is pointed at {@linkcode gleifInputPath}, the directory itself.
 */
export async function fetchGLEIF(options: FetchGLEIFOptions, report?: (line: string) => void): Promise<FetchSummary> {
	await using client = new APIClient({ displayName: SLUG, retry: true })

	// Awaited rather than returned: `await using` disposes the client when this scope exits.
	return await downloadGLEIF(client, {
		outputDir: options.outRoot(SLUG),
		verifyDigest: options.verifyDigest,
		force: options.force,
		retryDelayMs: options.retryDelayMs,
		report,
	})
}
