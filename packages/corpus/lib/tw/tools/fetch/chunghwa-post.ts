// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Fetches Chunghwa Post's list of its post offices (中華郵政全國營業據點, data.gov.tw dataset 5950),
 *   the source of Taiwan's post offices in the structures layer (`#tw/structures/chunghwa-post`).
 *
 *   The dataset record at `https://data.gov.tw/api/v2/rest/dataset/5950` names the provider
 *   (提供機關 中華郵政股份有限公司), the license (政府資料開放授權條款－第1版, the Open Government Data License, Taiwan, v1.0)
 *   and the CSV distribution on `www.post.gov.tw`.
 *   The record is saved beside the CSV as `dataset.json`, because it holds the license
 *   and the update date the attribution cites.
 *
 *   The CSV is downloaded to a staging file and moves into place only once it parses
 *   and holds the columns the adapter reads.
 *   A failed run leaves the previous file as it was.
 *
 *   Invoke via `mailwoman corpus fetch tw-chunghwa-post-offices`.
 */

import { APIClient } from "@mailwoman/core/api"
import { isSuccessStatus } from "@mailwoman/core/api/responses"
import { sha256File } from "@mailwoman/core/crypto/hash"
import { ByteFormatter } from "@mailwoman/core/fs/formatters"
import { statPath } from "@mailwoman/core/fs/readers/stat"
import {
	makeDirectories,
	movePath,
	removePathIfPresent,
	stagingSiblingPath,
	writeLocalJSONFile,
} from "@mailwoman/core/fs/writers"
import { PathBuilder, type PathBuilderLike } from "path-ts"

import { readCSVRecords } from "#recipes/scaffold"
import type { BaseFetchOptions, FetchSummary, SourceManifest } from "#tools/fetch/download"
import { DEFAULT_RETRY_DELAY_MS, streamDownload, writeManifest } from "#tools/fetch/download"
import {
	TW_CHUNGHWA_POST_COLUMNS,
	TW_CHUNGHWA_POST_FILENAME,
	TW_CHUNGHWA_POST_SOURCE_ID,
} from "#tw/structures/chunghwa-post"

/**
 * The dataset record on data.gov.tw.
 */
export const TW_CHUNGHWA_POST_DATASET_URL = "https://data.gov.tw/api/v2/rest/dataset/5950"

/**
 * The CSV distribution the dataset record names.
 */
export const TW_CHUNGHWA_POST_CSV_URL =
	"https://www.post.gov.tw/post/internet/Templates/getOpenDataFile.jsp?vkey=B484EB27-B3F0-4D02-8F62-047D20C64078"

/**
 * The file the dataset record is saved to, beside the CSV.
 */
export const TW_CHUNGHWA_POST_DATASET_FILENAME = "dataset.json"

const SLUG = TW_CHUNGHWA_POST_SOURCE_ID

/**
 * The parts of the data.gov.tw dataset record a fetch reads.
 */
interface TWDatasetRecord {
	success?: boolean
	result?: { title?: string; modifiedDate?: string; license?: string; publisher?: string }
}

/**
 * What one run recorded.
 * `publisher_version` is the record's `modifiedDate`.
 */
export interface TWChunghwaPostManifest extends SourceManifest {
	dataset_url: string
	records: number
}

export interface DownloadTWChunghwaPostOptions {
	outputDir: PathBuilderLike
	retryDelayMs?: number
	report?: (line: string) => void
}

/**
 * Downloads the CSV into `<outputDir>/post-offices.csv` and writes the dataset record and the manifest.
 *
 * @throws When the CSV answers an error status, or lacks a column the adapter reads.
 */
export async function downloadTWChunghwaPost(
	client: Pick<APIClient, "fetch">,
	options: DownloadTWChunghwaPostOptions
): Promise<FetchSummary> {
	const { report } = options
	const destDir = PathBuilder.from(options.outputDir)
	const csvPath = destDir(TW_CHUNGHWA_POST_FILENAME)

	report?.(`=== ${SLUG} / ${TW_CHUNGHWA_POST_FILENAME}`)

	const { data: dataset } = await client.fetch<TWDatasetRecord>({ url: TW_CHUNGHWA_POST_DATASET_URL })
	const result = dataset?.result ?? {}

	report?.(`  ${result.title ?? "untitled"}; modified ${result.modifiedDate ?? "unstated"}`)

	await makeDirectories(destDir)

	const staging = stagingSiblingPath(csvPath)
	let records = 0

	try {
		const status = await streamDownload(TW_CHUNGHWA_POST_CSV_URL, staging, {
			timeoutMs: 300_000,
			retries: 3,
			retryDelayMs: options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS,
		})

		if (!isSuccessStatus(status)) throw new Error(`${SLUG}: ${TW_CHUNGHWA_POST_CSV_URL} answered HTTP ${status}`)

		for await (const record of readCSVRecords(staging)) {
			if (records === 0) {
				const missing = TW_CHUNGHWA_POST_COLUMNS.filter((column) => !(column in record))

				if (missing.length) throw new Error(`${SLUG}: the CSV has no column ${missing.join(", ")}`)
			}

			records++
		}

		if (!records) throw new Error(`${SLUG}: the CSV holds no row`)

		await movePath(staging, csvPath)
	} finally {
		await removePathIfPresent(staging)
	}

	await writeLocalJSONFile((dataset ?? {}) as Record<string, unknown>, destDir(TW_CHUNGHWA_POST_DATASET_FILENAME))

	const sha256 = await sha256File(csvPath)
	const { size: bytes } = await statPath(csvPath)

	const manifest: TWChunghwaPostManifest = {
		source_url: TW_CHUNGHWA_POST_CSV_URL,
		dataset_url: TW_CHUNGHWA_POST_DATASET_URL,
		filename: TW_CHUNGHWA_POST_FILENAME,
		records,
		bytes,
		sha256,
		...(result.modifiedDate ? { publisher_version: result.modifiedDate } : {}),
		downloaded_at: new Date().toISOString(),
	}

	await writeManifest(destDir("MANIFEST.json"), manifest)

	report?.(`  ✓ ${records.toLocaleString()} rows, ${ByteFormatter.formatIEC(bytes)}  sha256=${sha256}`)

	return { fetched: 1, skipped: 0, failed: 0, failedCodes: [] }
}

/**
 * The registry entry.
 */
export async function fetchTWChunghwaPost(
	options: BaseFetchOptions,
	report?: (line: string) => void
): Promise<FetchSummary> {
	await using client = new APIClient({ displayName: SLUG, retry: true })

	// Awaited rather than returned: `await using` disposes the client when this scope exits.
	return await downloadTWChunghwaPost(client, {
		outputDir: options.outRoot(SLUG),
		retryDelayMs: options.retryDelayMs,
		report,
	})
}
