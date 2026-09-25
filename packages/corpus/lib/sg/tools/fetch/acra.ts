/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Fetches the ACRA corporate-entity CSVs for Singapore from data.gov.sg, which publishes them with fielded addresses.
 */

import { BYTES_PER_KIB } from "@mailwoman/core/fs/formatters"
import { pathExists } from "@mailwoman/core/fs/readers"
import { makeDirectories } from "@mailwoman/core/fs/writers"
import { sha256File } from "@mailwoman/core/hash"
import { sleep } from "@mailwoman/core/utils/sleep"

import type {
	BaseFetchOptions,
	FetchSummary,
	SourceCollectionManifest,
	SourceManifest,
} from "#tools/fetch/download/index"
import { loadCollectionFiles, streamBodyToFile, withRetries, writeManifest } from "#tools/fetch/download/index"

const SLUG = "acra-sg"
const COLLECTION_URL = "https://api-production.data.gov.sg/v2/public/api/collections/2/metadata"
const DATASET_API = "https://api-production.data.gov.sg/v2/public/api/datasets"
const DOWNLOAD_API = "https://api-open.data.gov.sg/v1/public/api/datasets"
const LICENSE = "Singapore Open Data Licence version 1.0 — https://data.gov.sg/open-data-licence"

// The licence prescribes this attribution sentence, and the manifest records it.
const ATTRIBUTION =
	"Contains information from ACRA Information on Corporate Entities accessed on <date> from data.gov.sg which is made available under the terms of the Singapore Open Data Licence version 1.0 https://data.gov.sg/open-data-licence"

const POLL_INTERVAL_MS = 3000
const POLL_ATTEMPTS = 40

/**
 * Options for {@link fetchACRASG}.
 */
export type FetchACRASGOptions = BaseFetchOptions

interface CollectionMetadata {
	data?: { collectionMetadata?: { childDatasets?: string[] } }
}

interface DatasetMetadata {
	data?: { name?: string; lastUpdatedAt?: string }
}

interface PollResponse {
	data?: { status?: string; url?: string }
}

async function readJSON<T>(url: string): Promise<T> {
	const res = await fetch(url, { headers: { accept: "application/json" } })

	if (!res.ok) throw new Error(`acra-sg: ${url} answered HTTP ${res.status}`)

	return (await res.json()) as T
}

/**
 * Asks data.gov.sg to prepare a CSV export and polls until the export's signed URL is ready.
 *
 * The function returns `undefined` when polling runs out of attempts.
 */
async function signedURLFor(datasetID: string): Promise<string | undefined> {
	await readJSON(`${DOWNLOAD_API}/${datasetID}/initiate-download`)

	for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
		await sleep(POLL_INTERVAL_MS)
		const poll = await readJSON<PollResponse>(`${DOWNLOAD_API}/${datasetID}/poll-download`)

		if (poll.data?.status === "DOWNLOAD_SUCCESS" && poll.data.url) return poll.data.url
	}

	return undefined
}

function filenameFor(name: string, datasetID: string): string {
	const letter = /\('([^']+)'\)/.exec(name)?.[1]

	return `acra-entities-${(letter ?? datasetID).toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}.csv`
}

/**
 * Downloads every dataset in the ACRA collection and writes a collection manifest after each file.
 *
 * The function skips a file that the previous manifest lists and that still exists on disk.
 */
export async function fetchACRASG(options: FetchACRASGOptions, report?: (line: string) => void): Promise<FetchSummary> {
	const destDir = options.outRoot(SLUG)
	await makeDirectories(destDir)
	const manifestPath = destDir("MANIFEST.json")

	const collection = await readJSON<CollectionMetadata>(COLLECTION_URL)
	const datasetIDs = collection.data?.collectionMetadata?.childDatasets ?? []
	report?.(`=== ${SLUG}: ${datasetIDs.length} datasets in collection 2`)

	const previous = await loadCollectionFiles(manifestPath)
	const files = new Map<string, SourceManifest>()
	let fetched = 0
	let skipped = 0
	const failedCodes: string[] = []

	for (const datasetID of datasetIDs) {
		const metadata = await readJSON<DatasetMetadata>(`${DATASET_API}/${datasetID}/metadata`)
		const name = metadata.data?.name ?? datasetID
		const filename = filenameFor(name, datasetID)
		const dest = destDir(filename)
		const before = previous.get(filename)

		if (before && (await pathExists(dest))) {
			files.set(filename, before)

			skipped++

			continue
		}

		report?.(`--- ${name} (${datasetID})`)
		let bytes: number

		try {
			bytes = await withRetries(
				async () => {
					const url = await signedURLFor(datasetID)

					if (!url) throw new Error(`the export never reached DOWNLOAD_SUCCESS for ${datasetID}`)
					const res = await fetch(url, { signal: AbortSignal.timeout(1_800_000) })

					if (!res.ok) throw new Error(`HTTP ${res.status} on the signed URL for ${datasetID}`)

					return streamBodyToFile(res, dest)
				},
				{ report, label: name }
			)
		} catch (error) {
			report?.(`  ✗ ${(error as Error).message}`)
			failedCodes.push(datasetID)

			continue
		}

		if (bytes < BYTES_PER_KIB) {
			report?.(`  ✗ ${bytes} bytes — an error page, not the register`)
			failedCodes.push(datasetID)

			continue
		}

		const sha = await sha256File(dest)

		files.set(filename, {
			source_url: `https://data.gov.sg/datasets/${datasetID}/view`,
			downloaded_at: new Date().toISOString(),
			filename,
			sha256: sha,
			bytes,
		})

		fetched++
		report?.(`  ✓ ${(bytes / 1024 / 1024).toFixed(1)} MB  sha256=${sha}`)

		const manifest: SourceCollectionManifest = {
			source: SLUG,
			source_url: "https://data.gov.sg/collections/2/view",
			license: LICENSE,
			attribution: ATTRIBUTION,
			downloaded_at: new Date().toISOString(),
			files: [...files.values()],
		}

		await writeManifest(manifestPath, manifest)
	}

	return { fetched, skipped, failed: failedCodes.length, failedCodes }
}
