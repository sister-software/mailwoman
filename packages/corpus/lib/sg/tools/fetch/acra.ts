/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Fetch Singapore's ACRA corporate-entity register from data.gov.sg: 27 monthly CSVs (one per first
 *   letter of the entity name plus "others"), 53 columns, the registered address FIELDED — `Block`,
 *   `Street Name`, `Level No`, `Unit No`, `Building Name`, `Postal Code` — which is the NPPES shape,
 *   so the corpus adapter renders the string and the spans fall out by construction. A Singapore
 *   postcode names one building, so the postcode column is also the join to the OneMap/Overture rows.
 *
 *   License: Singapore Open Data Licence version 1.0 (attribution; commercial use, modification and
 *   adaptation permitted; no share-alike). The prescribed attribution sentence goes in the manifest.
 *
 *   data.gov.sg serves a dataset in two calls: `initiate-download` prepares a signed URL and
 *   `poll-download` answers it once the export is ready.
 *
 *   Invoke via `mailwoman corpus fetch acra-sg --out-root <path>`.
 */

import { BYTES_PER_KIB } from "@mailwoman/core/fs/formatters"
import { pathExists } from "@mailwoman/core/fs/readers"
import { makeDirectories } from "@mailwoman/core/fs/writers"
import { sha256File } from "@mailwoman/core/hash"
import { sleep } from "@mailwoman/core/utils/sleep"
import { join } from "path-ts"

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

const ATTRIBUTION =
	"Contains information from ACRA Information on Corporate Entities accessed on <date> from data.gov.sg which is made available under the terms of the Singapore Open Data Licence version 1.0 https://data.gov.sg/open-data-licence"

const POLL_INTERVAL_MS = 3000
const POLL_ATTEMPTS = 40

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
 * Ask the portal to prepare the CSV export, then poll until it names the signed URL.
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

export async function fetchACRASG(options: FetchACRASGOptions, report?: (line: string) => void): Promise<FetchSummary> {
	const destDir = join(options.outRoot, SLUG)
	await makeDirectories(destDir)
	const manifestPath = join(destDir, "MANIFEST.json")

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
		const dest = join(destDir, filename)
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
