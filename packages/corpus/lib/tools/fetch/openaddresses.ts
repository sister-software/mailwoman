import { APIClient, isSuccessStatus } from "@mailwoman/core/api"
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Fetch an OpenAddresses country collection from batch.openaddresses.io.
 */
/* oxlint-disable sister-software/prefer-region-over-marks -- these markers label steps inside one
   procedure rather than sections of declarations. A region there folds no element a reader wants folded. */
import { ByteFormatter } from "@mailwoman/core/fs/formatters"
import { statPath, pathExists } from "@mailwoman/core/fs/readers"
import { openWriteStream, pipeline } from "@mailwoman/core/fs/streams"
import { movePath, removePathIfPresent, makeDirectories } from "@mailwoman/core/fs/writers"
import { sha256File } from "@mailwoman/core/hash"
import { runFile, spawnProcess } from "@mailwoman/core/process"
import { isoSeconds } from "@mailwoman/core/utils"
import type { PathBuilderLike } from "path-ts"
import { AsyncSpliterator } from "spliterator"

import { $private } from "#env"
import type { BaseFetchOptions, FetchSummary } from "#tools/fetch/download/index"
import { streamDownload, writeManifest } from "#tools/fetch/download/index"

const HTTP_OK = 200

/**
 * Below this size the file is a stub or an error body rather than an archive.
 */
const MIN_PLAUSIBLE_ARCHIVE_BYTES = 10_240

const OA_BASE = "https://batch.openaddresses.io"

/**
 * OA assigns stable integer collection IDs; re-check `GET /api/collections` for a country absent here.
 */
const OA_COLLECTION_IDS: Record<string, number> = {
	ca: 6,
	"us-west": 4,
	"us-south": 3,
	"us-northeast": 2,
	"us-midwest": 5,
	global: 1,
}

export interface FetchOpenAddressesOptions extends BaseFetchOptions {
	country?: string
}

interface OaCollection {
	name?: string
	id?: number
	human?: string
	size?: number
}

async function gunzipToFile(src: PathBuilderLike, dest: PathBuilderLike): Promise<void> {
	const child = spawnProcess("nice", ["-n", "15", "ionice", "-c", "3", "gunzip", "-c", src], {
		stdio: ["ignore", "pipe", "inherit"],
	})

	await pipeline(child.stdout!, openWriteStream(dest))

	await new Promise<void>((resolve, reject) => {
		child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`gunzip exited with code ${code}`))))
		child.on("error", reject)
	})
}

export async function fetchOpenAddresses(
	options: FetchOpenAddressesOptions,
	report?: (line: string) => void
): Promise<FetchSummary> {
	const country = options.country ?? "ca"
	const token = $private.OA_BATCH_TOKEN

	const destDir = options.outRoot("openaddresses", country)
	const manifestPath = destDir("MANIFEST.json")
	const outputFile = destDir("collection.geojsonl")

	const fail = (code: string): FetchSummary => ({ fetched: 0, skipped: 0, failed: 1, failedCodes: [code] })

	report?.(`=== fetch openaddresses: country=${country}`)
	report?.(`    dest: ${destDir}`)

	await makeDirectories(destDir)

	if (!token) {
		report?.(`
ERROR: OA_BATCH_TOKEN is not set.

As of 2026-05-18, batch.openaddresses.io requires a registered (free) account
to download collection files.  Data remains openly licensed — the auth gate
is there to prevent CDN abuse, not to restrict access.

Steps to get a token:
  1. Register at: https://batch.openaddresses.io/register
  2. Verify your email and log in.
  3. Go to Profile → "Create Token" → copy the token.
  4. Export it in this shell:
       export OA_BATCH_TOKEN=<your-token>
  5. Re-run this command.

The Canada collection (ca) is ~2 GiB compressed / ~7 GiB uncompressed
(estimated), so budget ~20–45 minutes at typical cloud-to-host bandwidth.
`)

		return fail("OA_BATCH_TOKEN")
	}

	let collectionID = OA_COLLECTION_IDS[country]

	if (collectionID === undefined) {
		report?.(`Unknown country code '${country}'. Fetching collection list to find ID...`)

		// The archive streams multi-gigabyte bodies to disk, where axios would buffer them in memory.
		const res = await new APIClient({
			displayName: "openaddresses-api",
			retry: true,
			axios: { headers: { Authorization: `Bearer ${token}`, "Accept-Encoding": "gzip, br" } },
		})
			// `validateStatus` keeps a non-2xx as a response rather than a throw: the caller reports the status and returns `fail(country)`, a graceful path this must not turn into an exception.
			.fetch<OaCollection[]>({
				url: `${OA_BASE}/api/collections`,
				timeout: 30_000,
				validateStatus: () => true,
			})

		if (!isSuccessStatus(res.status)) {
			report?.(`ERROR: GET /api/collections returned HTTP ${res.status}.`)

			return fail(country)
		}

		const collections = res.data
		const match = collections.find((item) => item.name === country)

		if (match?.id === undefined) {
			report?.(`ERROR: Could not find a collection named '${country}' in GET /api/collections.`)
			report?.(`Available collections:`)

			for (const item of collections) {
				const size = (item.size ?? 0).toLocaleString()
				report?.(`  ${(item.name ?? "").padEnd(20)}  id=${item.id}  ${item.human ?? ""}  size=${size} bytes`)
			}

			return fail(country)
		}

		collectionID = match.id
		report?.(`  Found collection id=${collectionID} for '${country}'`)
	}

	report?.(`  Resolving download URL for collection id=${collectionID}...`)
	report?.(`  Attempting authenticated download...`)

	const tmpGz = destDir("collection.geojsonl.gz.tmp")
	const tmpRaw = destDir("collection.geojsonl.tmp")
	const sourceURL = `${OA_BASE}/api/collections/${collectionID}/download`

	let httpStatus = await streamDownload(sourceURL, tmpGz, {
		headers: { Authorization: `Bearer ${token}` },
		timeoutMs: 7_200_000,
		retries: 3,
		retryDelayMs: 30_000,
	})

	if (httpStatus !== HTTP_OK) {
		httpStatus = await streamDownload(`${OA_BASE}/api/collections/${collectionID}/geojsonl.gz?token=${token}`, tmpGz, {
			timeoutMs: 7_200_000,
			retries: 3,
			retryDelayMs: 30_000,
		})
	}

	if (httpStatus !== HTTP_OK) {
		await removePathIfPresent(tmpGz)

		report?.(`
ERROR: Download returned HTTP ${httpStatus}.

Likely causes:
  1. OA_BATCH_TOKEN is invalid or expired — re-create it at Profile → Tokens.
  2. The collection download endpoint URL has changed (this module was written
     against the 2026-05-18 batch.openaddresses.io API; it may need updating).
  3. Network error or CDN outage.

Manual download (after logging in to batch.openaddresses.io):
  - Navigate to https://batch.openaddresses.io/collection/${collectionID}
  - Click "GeoJSON+LD" to download the collection.
  - Save as: ${outputFile}

URL tried: ${OA_BASE}/api/collections/${collectionID}/download
`)

		return fail(country)
	}

	const fileMagic = (await runFile("file", ["--brief", tmpGz]).catch(() => ({ stdout: "" }))).stdout

	if (/gzip|compressed/i.test(fileMagic)) {
		report?.(`  Decompressing gzip archive...`)
		await gunzipToFile(tmpGz, tmpRaw)
		await removePathIfPresent(tmpGz)
		await movePath(tmpRaw, outputFile)
	} else if (/JSON|ASCII|UTF-8/i.test(fileMagic)) {
		await movePath(tmpGz, outputFile)
		await removePathIfPresent(tmpRaw)
	} else {
		await movePath(tmpGz, outputFile)
		report?.(`  WARNING: Downloaded file type is '${fileMagic.trim()}' — may need manual decompression.`)
	}

	if (!(await pathExists(outputFile))) {
		report?.(`ERROR: Output file not found at ${outputFile} after download.`)

		return fail(country)
	}

	const size = (await statPath(outputFile)).size

	if (size < MIN_PLAUSIBLE_ARCHIVE_BYTES) {
		report?.(`ERROR: File is suspiciously small (${size} bytes) — likely an error response.`)

		return fail(country)
	}

	const sha = await sha256File(outputFile)
	const rowCount = await AsyncSpliterator.count(outputFile)
	const downloadedAt = isoSeconds()

	const manifest = {
		source_url: sourceURL,
		collection_id: collectionID,
		country,
		filename: "collection.geojsonl",
		downloaded_at: downloadedAt,
		sha256: sha,
		bytes: size,
		row_count: rowCount,
		notes:
			"batch.openaddresses.io requires a free registered account for downloads. License is mixed per-row; use the openaddresses adapter with allowShareAlike=false (default) to filter Tier-C rows.",
	}

	await writeManifest(manifestPath, manifest)

	report?.(`  ✓ ${ByteFormatter.formatIEC(size)}  rows=${rowCount}  sha256=${sha}`)
	report?.(`  MANIFEST written to ${manifestPath}`)
	report?.(`=== done`)
	report?.(`Feed to the adapter:`)
	report?.(`  mailwoman corpus run openaddresses \\`)
	report?.(`    --input ${outputFile} \\`)
	report?.(`    --country ${country.toUpperCase()} \\`)
	report?.(`    --output ${options.outRoot}`)

	return { fetched: 1, skipped: 0, failed: 0, failedCodes: [] }
}
