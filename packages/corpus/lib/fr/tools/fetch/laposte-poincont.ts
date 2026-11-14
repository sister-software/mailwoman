// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Fetches La Poste's list of its points of contact, the dataset `laposte-poincont2`
 *   (« Liste des bureaux de poste, agences postales et relais poste ») on `data.laposte.fr`,
 *   the source of the `fr-laposte-poincont` adapter and the French post offices of the structures layer.
 *
 *   The portal is a data-fair instance.
 *   The dataset record at `/data-fair/api/v1/datasets/laposte-poincont2` states the
 *   license (`Licence Ouverte / Open Licence`), the record count and `dataUpdatedAt`.
 *
 *   The rows are paged from `/lines` at 10,000 per request, following each answer's `next` link.
 *
 *   The record is saved beside the rows as `dataset.json`, because it holds the publisher's
 *   license statement and the update date Licence Ouverte asks a reuser to cite.
 *   A pull whose row count differs from the record's `count` is refused, and the previous file stays.
 *
 *   Invoke via `mailwoman corpus fetch fr-laposte-poincont`.
 */

import { APIClient } from "@mailwoman/core/api"
import { ByteFormatter } from "@mailwoman/core/fs/formatters"
import { statPath } from "@mailwoman/core/fs/readers/stat"
import {
	appendLocalTextFile,
	makeDirectories,
	movePath,
	removePathIfPresent,
	stagingSiblingPath,
	writeLocalJSONFile,
} from "@mailwoman/core/fs/writers"
import { sha256File } from "@mailwoman/core/hash"
import { stringifyJSON } from "@mailwoman/core/json"
import { PathBuilder, type PathBuilderLike } from "path-ts"

import {
	FR_LAPOSTE_POINCONT_ADAPTER_ID,
	LAPOSTE_POINCONT_FIELDS,
	LAPOSTE_POINCONT_FILENAME,
} from "#fr/adapters/laposte-poincont/adapter"
import type { BaseFetchOptions, FetchSummary, SourceManifest } from "#tools/fetch/download"
import { writeManifest } from "#tools/fetch/download"

/**
 * The dataset's data-fair API root.
 */
export const LAPOSTE_POINCONT_API_URL = "https://data.laposte.fr/data-fair/api/v1/datasets/laposte-poincont2"

/**
 * The dataset's page.
 * It states the license.
 */
export const LAPOSTE_POINCONT_PAGE_URL = "https://data.laposte.fr/datasets/laposte-poincont2"

/**
 * The most rows one `/lines` request answers.
 */
export const LAPOSTE_POINCONT_PAGE_SIZE = 10_000

/**
 * The file the dataset record is saved to, beside the rows.
 */
export const LAPOSTE_POINCONT_DATASET_FILENAME = "dataset.json"

const SLUG = FR_LAPOSTE_POINCONT_ADAPTER_ID

/**
 * The parts of the data-fair dataset record a fetch reads.
 */
export interface DataFairDatasetRecord {
	title?: string
	count?: number
	dataUpdatedAt?: string
	updatedAt?: string
	origin?: string
	license?: { title?: string; href?: string }
}

/**
 * One `/lines` answer.
 */
interface DataFairLines {
	total?: number
	next?: string
	results?: Array<Record<string, unknown>>
}

/**
 * What one run recorded.
 *
 * `publisher_version` is the record's `dataUpdatedAt`, the date Licence Ouverte asks a reuser to cite.
 */
export interface LaPostePoincontManifest extends SourceManifest {
	dataset_url: string
	records: number
	license_title: string | null
	license_url: string | null
}

/**
 * The first `/lines` URL, selecting the fields the adapter reads.
 */
export function laPostePoincontLinesURL(): string {
	const select = encodeURIComponent(LAPOSTE_POINCONT_FIELDS.join(","))

	return `${LAPOSTE_POINCONT_API_URL}/lines?size=${LAPOSTE_POINCONT_PAGE_SIZE}&select=${select}`
}

/**
 * One `/lines` row with only the fields the adapter reads, in their declared order,
 * a field the row lacks written as `null`.
 */
export function selectLaPosteFields(row: Readonly<Record<string, unknown>>): Record<string, unknown> {
	return Object.fromEntries(LAPOSTE_POINCONT_FIELDS.map((field) => [field, row[field] ?? null]))
}

export interface DownloadLaPostePoincontOptions {
	outputDir: PathBuilderLike
	signal?: AbortSignal
	report?: (line: string) => void
}

/**
 * Pages every row into `<outputDir>/laposte-poincont2.jsonl` and writes the manifest.
 *
 * @throws When the record states no count, a page answers no `results`,
 * or the rows written differ from the record's count.
 */
export async function downloadLaPostePoincont(
	client: Pick<APIClient, "fetch">,
	options: DownloadLaPostePoincontOptions
): Promise<FetchSummary> {
	const { report, signal } = options
	const destDir = PathBuilder.from(options.outputDir)
	const rowsPath = destDir(LAPOSTE_POINCONT_FILENAME)

	report?.(`=== ${SLUG} / ${LAPOSTE_POINCONT_FILENAME}`)

	const { data: dataset } = await client.fetch<DataFairDatasetRecord>({ url: LAPOSTE_POINCONT_API_URL, signal })

	if (typeof dataset?.count !== "number") {
		throw new TypeError(`${SLUG}: ${LAPOSTE_POINCONT_API_URL} states no count`)
	}

	report?.(
		`  ${dataset.count.toLocaleString()} rows, license ${dataset.license?.title ?? "absent"}, data updated ${dataset.dataUpdatedAt ?? "unstated"}`
	)

	await makeDirectories(destDir)

	const staging = stagingSiblingPath(rowsPath)
	let written = 0

	try {
		await appendLocalTextFile("", staging)

		let url: string | undefined = laPostePoincontLinesURL()

		while (url) {
			const { data: page }: { data: DataFairLines | null } = await client.fetch<DataFairLines>({ url, signal })

			if (!Array.isArray(page?.results)) throw new TypeError(`${SLUG}: ${url} answered no results`)

			if (!page.results.length) break

			await appendLocalTextFile(
				`${page.results.map((row) => stringifyJSON(selectLaPosteFields(row))).join("\n")}\n`,
				staging
			)

			written += page.results.length
			report?.(`    ${written.toLocaleString()} / ${dataset.count.toLocaleString()}`)

			url = page.next
		}

		if (written !== dataset.count) {
			throw new Error(`${SLUG}: the record states ${dataset.count} rows and the pull wrote ${written}`)
		}

		await movePath(staging, rowsPath)
	} finally {
		await removePathIfPresent(staging)
	}

	await writeLocalJSONFile(dataset as Record<string, unknown>, destDir(LAPOSTE_POINCONT_DATASET_FILENAME))

	const sha256 = await sha256File(rowsPath)
	const { size: bytes } = await statPath(rowsPath)

	const manifest: LaPostePoincontManifest = {
		source_url: laPostePoincontLinesURL(),
		dataset_url: LAPOSTE_POINCONT_API_URL,
		filename: LAPOSTE_POINCONT_FILENAME,
		records: written,
		license_title: dataset.license?.title ?? null,
		license_url: dataset.license?.href ?? null,
		bytes,
		sha256,
		...(dataset.dataUpdatedAt ? { publisher_version: dataset.dataUpdatedAt } : {}),
		downloaded_at: new Date().toISOString(),
	}

	await writeManifest(destDir("MANIFEST.json"), manifest)

	report?.(`  ✓ ${written.toLocaleString()} rows, ${ByteFormatter.formatIEC(bytes)}  sha256=${sha256}`)

	return { fetched: 1, skipped: 0, failed: 0, failedCodes: [] }
}

/**
 * The path `#fr/adapters/laposte-poincont/adapter` reads, given the root a fetch wrote under.
 */
export function laPostePoincontInputPath(outRoot: BaseFetchOptions["outRoot"]): PathBuilderLike {
	return outRoot(SLUG, LAPOSTE_POINCONT_FILENAME)
}

export interface FetchLaPostePoincontOptions extends BaseFetchOptions {
	signal?: AbortSignal
}

/**
 * The registry entry.
 */
export async function fetchLaPostePoincont(
	options: FetchLaPostePoincontOptions,
	report?: (line: string) => void
): Promise<FetchSummary> {
	await using client = new APIClient({ displayName: SLUG, retry: true, minRequestIntervalMs: 500 })

	// Awaited rather than returned: `await using` disposes the client when this scope exits.
	return await downloadLaPostePoincont(client, { outputDir: options.outRoot(SLUG), signal: options.signal, report })
}
