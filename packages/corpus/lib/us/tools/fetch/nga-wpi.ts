// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Fetches NGA's World Port Index (Pub. 150), the source of the structures
 *   layer's seaports (`#us/structures/nga-wpi`).
 *
 *   The Maritime Safety Information portal serves the index as `UpdatedPub150.csv` from its
 *   publications download endpoint, and calls that CSV the official version of the content.
 *   While the portal is under maintenance, its maintenance page links the same file
 *   zipped as `apology_objects/WPI.zip`, so a fetch that the download endpoint refuses
 *   reads the CSV out of that archive and records which URL served it.
 *
 *   The CSV is written to a staging file and moves into place only once it parses
 *   and holds the columns the structures module reads.
 *   A failed run leaves the previous file as it was.
 *
 *   Invoke via `mailwoman corpus fetch nga-wpi`.
 */

import { APIClient } from "@mailwoman/core/api"
import { sha256File } from "@mailwoman/core/crypto/hash"
import { ByteFormatter } from "@mailwoman/core/fs/formatters"
import { statPath } from "@mailwoman/core/fs/readers/stat"
import {
	makeDirectories,
	movePath,
	removePathIfPresent,
	stagingSiblingPath,
	writeLocalFile,
} from "@mailwoman/core/fs/writers"
import { readZipEntry } from "@mailwoman/core/fs/zip"
import { PathBuilder, type PathBuilderLike } from "path-ts"

import { readCSVRecords } from "#recipes/scaffold"
import type { BaseFetchOptions, FetchSummary, SourceManifest } from "#tools/fetch/download"
import { writeManifest } from "#tools/fetch/download"
import { downloadZipArchive } from "#tools/fetch/zip-archive"
import { NGA_WPI_COLUMNS, NGA_WPI_FILENAME, NGA_WPI_SOURCE_ID } from "#us/structures/nga-wpi"

/**
 * The CSV as the portal's publications endpoint serves it.
 */
export const NGA_WPI_CSV_URL =
	"https://msi.nga.mil/api/publications/download?key=16920959/SFH00000/UpdatedPub150.csv&type=view"

/**
 * The zipped CSV the portal's maintenance page links.
 */
export const NGA_WPI_MAINTENANCE_ZIP_URL = "https://msi.nga.mil/apology_objects/WPI.zip"

const SLUG = NGA_WPI_SOURCE_ID

/**
 * What one run recorded.
 *
 * `publisher_version` is the `Last-Modified` the serving URL stated.
 */
export interface NGAWPIManifest extends SourceManifest {
	records: number
}

export interface DownloadNGAWPIOptions {
	outputDir: PathBuilderLike
	report?: (line: string) => void
}

/**
 * Writes the CSV to `staging` from the download endpoint, or from the maintenance archive when
 * the endpoint answers anything but a CSV, and answers the URL that served it and its `Last-Modified`.
 */
async function downloadCSV(
	client: Pick<APIClient, "fetch">,
	staging: string,
	report?: (line: string) => void
): Promise<{ url: string; lastModified: string | null }> {
	try {
		const response = await client.fetch<ArrayBuffer>({ url: NGA_WPI_CSV_URL, responseType: "arraybuffer" })
		const body = Buffer.from(response.data)

		// The portal answers an outage with its html maintenance page under HTTP 200.
		if (!body.subarray(0, 200).toString("utf8").includes("World Port Index Number")) {
			throw new Error(`${NGA_WPI_CSV_URL} answered ${body.byteLength} bytes without the CSV header`)
		}

		await writeLocalFile(body, staging)

		const headers = response.headers as Record<string, string> | undefined

		return { url: NGA_WPI_CSV_URL, lastModified: headers?.["last-modified"] ?? null }
	} catch (error) {
		report?.(`  download endpoint refused (${error instanceof Error ? error.message : String(error)})`)
		report?.(`  reading the maintenance archive ${NGA_WPI_MAINTENANCE_ZIP_URL}`)
	}

	const archive = stagingSiblingPath(`${staging}.zip`)

	try {
		const { lastModified } = await downloadZipArchive(client, { url: NGA_WPI_MAINTENANCE_ZIP_URL, dest: archive })
		const chunks: Uint8Array[] = []

		for await (const chunk of readZipEntry(archive, NGA_WPI_FILENAME)) {
			chunks.push(chunk)
		}

		await writeLocalFile(Buffer.concat(chunks), staging)

		return { url: NGA_WPI_MAINTENANCE_ZIP_URL, lastModified }
	} finally {
		await removePathIfPresent(archive)
	}
}

/**
 * Downloads the index into `<outputDir>/UpdatedPub150.csv` and writes the manifest.
 *
 * @throws When neither URL serves the CSV, or the CSV lacks a column the structures module reads.
 */
export async function downloadNGAWPI(
	client: Pick<APIClient, "fetch">,
	options: DownloadNGAWPIOptions
): Promise<FetchSummary> {
	const { report } = options
	const destDir = PathBuilder.from(options.outputDir)
	const csvPath = destDir(NGA_WPI_FILENAME)

	report?.(`=== ${SLUG} / ${NGA_WPI_FILENAME}`)

	await makeDirectories(destDir)

	const staging = stagingSiblingPath(csvPath)
	let records = 0
	let served: { url: string; lastModified: string | null }

	try {
		served = await downloadCSV(client, staging, report)

		for await (const record of readCSVRecords(staging)) {
			if (records === 0) {
				const missing = NGA_WPI_COLUMNS.filter((column) => !(column in record))

				if (missing.length) throw new Error(`${SLUG}: the CSV has no column ${missing.join(", ")}`)
			}

			records++
		}

		if (!records) throw new Error(`${SLUG}: the CSV holds no row`)

		await movePath(staging, csvPath)
	} finally {
		await removePathIfPresent(staging)
	}

	const sha256 = await sha256File(csvPath)
	const { size: bytes } = await statPath(csvPath)
	const publisherVersion = served.lastModified ? new Date(served.lastModified).toISOString() : null

	const manifest: NGAWPIManifest = {
		source_url: served.url,
		filename: NGA_WPI_FILENAME,
		records,
		bytes,
		sha256,
		...(publisherVersion ? { publisher_version: publisherVersion } : {}),
		downloaded_at: new Date().toISOString(),
	}

	await writeManifest(destDir("MANIFEST.json"), manifest)

	report?.(`  ✓ ${records.toLocaleString()} ports, ${ByteFormatter.formatIEC(bytes)}  sha256=${sha256}`)

	return { fetched: 1, skipped: 0, failed: 0, failedCodes: [] }
}

/**
 * The registry entry.
 */
export async function fetchNGAWPI(options: BaseFetchOptions, report?: (line: string) => void): Promise<FetchSummary> {
	await using client = new APIClient({ displayName: SLUG, retry: true })

	// Awaited rather than returned: `await using` disposes the client when this scope exits.
	return await downloadNGAWPI(client, { outputDir: options.outRoot(SLUG), report })
}
