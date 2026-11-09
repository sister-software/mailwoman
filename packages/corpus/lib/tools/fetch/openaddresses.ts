/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Fetch from batch.openaddresses.io: a country collection, or individual sources' latest job outputs.
 */
/* oxlint-disable sister-software/prefer-region-over-marks -- these markers label steps inside one
   procedure rather than sections of declarations. A region there folds no element a reader wants folded. */
import { APIClient, isSuccessStatus } from "@mailwoman/core/api"
import { dataRootPath } from "@mailwoman/core/data-root"
import { ByteFormatter } from "@mailwoman/core/fs/formatters"
import { readFileRange, readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { statPath, pathExists } from "@mailwoman/core/fs/readers/stat"
import { openWriteStream, pipeline } from "@mailwoman/core/fs/streams"
import { movePath, removePathIfPresent, makeDirectories } from "@mailwoman/core/fs/writers"
import { sha256File } from "@mailwoman/core/hash"
import { runFile, spawnProcess } from "@mailwoman/core/process"
import { isoDate, isoSeconds } from "@mailwoman/core/utils"
import { resolvePath, type PathBuilderLike } from "path-ts"
import { AsyncSpliterator } from "spliterator"

import { openAddressesSourceCacheName } from "#address-records/openaddresses"
import { $private } from "#env"
import type { BaseFetchOptions, FetchSummary } from "#tools/fetch/download"
import { streamDownload, writeManifest } from "#tools/fetch/download"

const HTTP_OK = 200

/**
 * Below this size the file is a stub or an error body rather than an archive.
 */
const MIN_PLAUSIBLE_ARCHIVE_BYTES = 10_240

const OA_BASE = "https://batch.openaddresses.io"

/**
 * OA assigns stable integer collection IDs.
 * Re-check `GET /api/collections` for a country absent here.
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
	/**
	 * OpenAddresses source members, such as `us/mi/statewide`.
	 *
	 * When set, the fetch caches each source's latest batch job output in `cache`
	 * instead of a country collection.
	 */
	sources?: readonly string[] | null
	/**
	 * Where source job outputs are cached, the US address layer's OpenAddresses cache.
	 */
	cache?: PathBuilderLike
}

/**
 * One entry of `GET /api/data`: a source layer's latest successful job.
 */
interface OaDataEntry {
	job?: number
	layer?: string
	updated?: number
}

/**
 * The fields of `GET /api/job/:id` the fetch checks.
 */
interface OaJob {
	count?: number
	status?: string
}

/**
 * What a cached source job output's `.RECORD.json` sidecar states.
 */
export interface OpenAddressesSourceRecord {
	member: string
	job: number
	/**
	 * When OpenAddresses last updated the job, as an ISO date.
	 */
	updated: string | null
	features: number
	bytes: number
	sha256: string
	fetchedAt: string
}

/**
 * The first two bytes of every gzip member.
 */
const GZIP_MAGIC = [0x1f, 0x8b] as const

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

/**
 * Caches each source's latest batch job output, `source.geojson.gz`, in `cache` under
 * {@linkcode openAddressesSourceCacheName}, with a `.RECORD.json` sidecar.
 *
 * The file is stored compressed, as the batch API serves it, because the
 * address-layer reader decompresses while it streams.
 * A source whose sidecar records the latest job, and whose file still has the recorded size, is skipped.
 *
 * A download whose feature count differs from the job's recorded count is refused and removed.
 */
export async function fetchOpenAddressesSources(
	options: { sources: readonly string[]; cache: PathBuilderLike },
	report?: (line: string) => void
): Promise<FetchSummary> {
	const token = $private.OA_BATCH_TOKEN

	if (!token) {
		report?.("ERROR: OA_BATCH_TOKEN is not set. Register at https://batch.openaddresses.io/register for a token.")

		return { fetched: 0, skipped: 0, failed: options.sources.length, failedCodes: ["OA_BATCH_TOKEN"] }
	}

	const headers = { Authorization: `Bearer ${token}` }
	const client = new APIClient({ displayName: "openaddresses-api", retry: true, axios: { headers } })
	const summary: FetchSummary = { fetched: 0, skipped: 0, failed: 0, failedCodes: [] }

	const fail = (member: string, reason: string) => {
		report?.(`  ✗ ${member}: ${reason}`)

		summary.failed++
		summary.failedCodes.push(member)
	}

	await makeDirectories(options.cache)

	for (const member of options.sources) {
		const name = openAddressesSourceCacheName(member)
		const destination = resolvePath(options.cache, name)
		const recordPath = resolvePath(options.cache, `${name}.RECORD.json`)

		const data = await client.fetch<OaDataEntry[]>({
			url: `${OA_BASE}/api/data`,
			params: { source: member, layer: "addresses" },
			timeout: 30_000,
		})

		const latest = data.data
			.filter((entry) => typeof entry.job === "number")
			.toSorted((a, b) => (b.updated ?? 0) - (a.updated ?? 0))[0]

		if (!latest?.job) {
			fail(member, "the batch API lists no addresses job")

			continue
		}

		const recorded = (await pathExists(recordPath))
			? await readLocalJSONFile<OpenAddressesSourceRecord>(recordPath)
			: null

		if (
			recorded?.job === latest.job &&
			(await pathExists(destination)) &&
			(await statPath(destination)).size === recorded.bytes
		) {
			report?.(`  = ${member}: job ${latest.job} already cached`)

			summary.skipped++

			continue
		}

		const job = (await client.fetch<OaJob>({ url: `${OA_BASE}/api/job/${latest.job}`, timeout: 30_000 })).data
		const partial = resolvePath(options.cache, `${name}.partial`)

		const status = await streamDownload(`${OA_BASE}/api/job/${latest.job}/output/source.geojson.gz`, partial, {
			headers,
			timeoutMs: 7_200_000,
			retries: 3,
			retryDelayMs: 30_000,
		})

		if (status !== HTTP_OK) {
			await removePathIfPresent(partial)
			fail(member, `job ${latest.job} output answered HTTP ${status}`)

			continue
		}

		const magic = await readFileRange(partial, 0, GZIP_MAGIC.length)

		if (!GZIP_MAGIC.every((byte, i) => magic[i] === byte)) {
			await removePathIfPresent(partial)
			fail(member, `job ${latest.job} output is not gzip`)

			continue
		}

		const features = await AsyncSpliterator.count(partial.toString())

		if (typeof job.count === "number" && features !== job.count) {
			await removePathIfPresent(partial)
			fail(member, `job ${latest.job} output holds ${features} features where the job records ${job.count}`)

			continue
		}

		const record: OpenAddressesSourceRecord = {
			member,
			job: latest.job,
			updated: latest.updated ? isoDate(new Date(latest.updated)) : null,
			features,
			bytes: (await statPath(partial)).size,
			sha256: await sha256File(partial),
			fetchedAt: isoSeconds(),
		}

		await movePath(partial, destination)
		await writeManifest(recordPath, record)

		report?.(
			`  ✓ ${member}: job ${record.job} (${record.updated}), ${record.features} features, ${ByteFormatter.formatIEC(record.bytes)}`
		)

		summary.fetched++
	}

	return summary
}

export async function fetchOpenAddresses(
	options: FetchOpenAddressesOptions,
	report?: (line: string) => void
): Promise<FetchSummary> {
	if (options.sources?.length) {
		return fetchOpenAddressesSources(
			{ sources: options.sources, cache: options.cache ?? dataRootPath("oa-cache") },
			report
		)
	}

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

	if (!collectionID) {
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

		if (!match?.id) {
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
			"batch.openaddresses.io requires a free registered account for downloads. The license is mixed per row, and the openaddresses adapter admits every row by default. Build with `mailwoman corpus build --license-policy share-alike-free` to refuse the share-alike rows, or pass `allowShareAlike: false` for an adapter-scoped drop.",
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
