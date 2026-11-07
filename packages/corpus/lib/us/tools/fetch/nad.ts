/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Fetch the US DOT National Address Database (NAD) — ~97 million structured US address-point
 *   records aggregated from state and local authorities. Source for the `usgov-nad` adapter.
 *   US Public Domain (17 U.S.C. § 105).
 *
 *   - Bounded per-chunk page concurrency (4× speedup at safe pressure)
 *   - 5× larger page size (5 000 vs. the old bash fetcher's 2 000) — fewer round-trips per chunk
 *   - A `complete: true` flag that is set only when every page in the chunk fetched without error
 *   - Built-in fetch with gzip/brotli decompression (no curl or Python subprocess per page)
 *   - Per-chunk manifest with sha256 + record count + error count
 *
 *   ## Source layout
 *
 *   The ArcGIS FeatureServer is the only fully-automated path. As of 2026-05:
 *
 *   - **`bulk`** mode takes the release's download link (Akamai blocks scripted requests on the DOT page). Pass
 *       `--nad-url <link>` from a browser visit to
 *       [https://www.transportation.gov/gis/national-address-database](https://www.transportation.gov/gis/national-address-database).
 *       It downloads `bulk/nad.zip`, extracts it to `bulk/extracted/`, and writes the text release to Parquet
 *       sorted by state and county beside it.
 *   - **`featureserver`** mode (default) pages the live FeatureService via objectid ranges, writing
 *       ndjson chunks into `<outRoot>/usgov-nad/featureserver/`.
 *
 *   ## Usage
 *
 *   ```sh
 *   mailwoman corpus fetch nad --out-root $MAILWOMAN_DATA_ROOT/corpus/sources
 *
 *   # Resume from an OID
 *   mailwoman corpus fetch nad --start-oid 34400001
 *
 *   # Increase concurrency on a fast link
 *   mailwoman corpus fetch nad --concurrency 8 --page-size 10000
 *   ```
 */

import { APIClient, pluckResponseData } from "@mailwoman/core/api"
import { ByteFormatter } from "@mailwoman/core/fs/formatters"
import { statPath, pathExists, tryStat } from "@mailwoman/core/fs/readers/stat"
import { makeDirectories, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { extractZipEntries } from "@mailwoman/core/fs/zip"
import { sha256File } from "@mailwoman/core/hash"
import { stringifyJSON } from "@mailwoman/core/json"
import { ResumeRefusedError, streamToDisk } from "@mailwoman/core/utils"
import type { PathBuilderLike } from "path-ts"

import type { BaseFetchOptions, FetchSummary, SourceManifest } from "#tools/fetch/download"
import { readManifest, writeManifest } from "#tools/fetch/download"
import { convertNADToParquet } from "#us/tools/fetch/nad/parquet"

const SLUG = "usgov-nad"

const FEATURE_SERVICE_URL =
	"https://services.arcgis.com/xOi1kZaI0eWDREZv/ArcGIS/rest/services/Address_Points_from_National_Address_Database_view/FeatureServer/0"

export interface FetchNADOptions extends BaseFetchOptions {
	/**
	 * Fetch strategy.
	 *
	 * @defaultValue `featureserver`
	 */
	mode?: "featureserver" | "bulk"
	/**
	 * Pre-signed S3 URL for bulk mode.
	 */
	nadURL?: string
	/**
	 * Records per output file.
	 *
	 * @defaultValue `100000`
	 */
	chunkSize?: number
	/**
	 * Records per http request.
	 *
	 * @defaultValue `5000`
	 */
	pageSize?: number
	/**
	 * Parallel page fetches within a chunk.
	 *
	 * @defaultValue `4`
	 */
	concurrency?: number
	/**
	 * Start objectid.
	 *
	 * @defaultValue `1`
	 */
	startOID?: number
	/**
	 * Stop before this OID.
	 *
	 * @defaultValue = total count.
	 */
	endOID?: number
}

interface ChunkManifest {
	source_url: string
	oid_range: [number, number]
	downloaded_at: string
	filename: string
	sha256: string
	bytes: number
	record_count: number
	page_errors: number
	complete: boolean
}

/**
 * ArcGIS paged reads.
 *
 * Retry is on: the loop walks objectid ranges to completion, since one throttled
 * page can otherwise end a multi-hour national download.
 * No rate budget — pages are requested one at a time and each assembles thousands of records server-side.
 */
const nadClient = new APIClient({
	displayName: "nad",
	retry: true,
	axios: { headers: { "Accept-Encoding": "gzip, br" } },
})

async function fetchPage(startOID: number, endOID: number, pageSize: number): Promise<unknown[]> {
	const url = new URL(`${FEATURE_SERVICE_URL}/query`)
	url.searchParams.set("where", `OBJECTID BETWEEN ${startOID} AND ${endOID}`)
	url.searchParams.set("outFields", "*")
	url.searchParams.set("f", "json")
	url.searchParams.set("resultRecordCount", String(pageSize))

	const data = await nadClient
		.fetch<{ features?: Array<{ attributes: unknown }>; error?: { message: string } }>({
			url: url.toString(),
			timeout: 120_000,
		})
		.then(pluckResponseData)

	if (data.error) throw new Error(`ArcGIS error on OID ${startOID}-${endOID}: ${data.error.message}`)

	return (data.features ?? []).map((f) => f.attributes)
}

async function discoverTotalCount(): Promise<number> {
	const url = new URL(`${FEATURE_SERVICE_URL}/query`)
	url.searchParams.set("where", "1=1")
	url.searchParams.set("returnCountOnly", "true")
	url.searchParams.set("f", "json")

	const data = await nadClient
		.fetch<{ count?: number }>({ url: url.toString(), timeout: 30_000 })
		.then(pluckResponseData)

	if (typeof data.count !== "number") throw new Error("NAD count query returned no count field")

	return data.count
}

/**
 * Fetch a single chunk by paging through its OID range with bounded concurrency.
 *
 * Returns the count of records written and the count of pages that errored.
 * The caller decides whether to mark the chunk complete based on errors === 0.
 *
 * Note(phase1): this is a JSON API pager rather than a file download —
 * the shared `downloadToFile` doesn't apply here.
 */
async function fetchChunk(
	chunkPath: PathBuilderLike,
	chunkStart: number,
	chunkEnd: number,
	pageSize: number,
	concurrency: number,
	report?: (line: string) => void
): Promise<{ recordCount: number; errors: number }> {
	const pageRanges: Array<[number, number]> = []

	for (let cursor = chunkStart; cursor <= chunkEnd; cursor += pageSize) {
		pageRanges.push([cursor, Math.min(cursor + pageSize - 1, chunkEnd)])
	}

	// Results indexed by page slot for in-order write.
	const pageResults: Array<{ rows: unknown[]; error: Error | null }> = pageRanges.map(() => ({
		rows: [],
		error: null,
	}))

	let nextSlot = 0

	const workers = Array.from({ length: Math.min(concurrency, pageRanges.length) }, async () => {
		while (true) {
			const slot = nextSlot++

			if (slot >= pageRanges.length) return
			const [s, e] = pageRanges[slot]!

			try {
				pageResults[slot]!.rows = await fetchPage(s, e, pageSize)
			} catch (error) {
				pageResults[slot]!.error = error as Error
				report?.(`    ✗ page ${s}-${e}: ${(error as Error).message}`)
			}
		}
	})

	await Promise.all(workers)

	// Single-writer phase — write all pages in OID order to keep ndjson deterministic.
	const lines: string[] = []
	let errors = 0

	for (const { rows, error } of pageResults) {
		if (error) {
			errors++

			continue
		}

		for (const row of rows) {
			lines.push(stringifyJSON(row))
		}
	}

	await writeLocalTextFile(lines, chunkPath)

	return { recordCount: lines.length, errors }
}

async function featureserverMode(options: FetchNADOptions, report?: (line: string) => void): Promise<FetchSummary> {
	const chunkSize = options.chunkSize ?? 100_000
	const pageSize = options.pageSize ?? 5000
	const concurrency = options.concurrency ?? 4
	const startOID = options.startOID ?? 1

	const chunkDir = options.outRoot(SLUG, "featureserver")
	await makeDirectories(chunkDir)

	report?.(`=== ${SLUG} / featureserver`)
	report?.(`  Discovering record count ...`)
	const totalCount = await discoverTotalCount()
	const endOID = options.endOID ?? totalCount
	report?.(`  Total records: ${totalCount.toLocaleString()}`)
	report?.(`  OID range: ${startOID.toLocaleString()} .. ${endOID.toLocaleString()}`)
	report?.(`  Chunk size: ${chunkSize}, page size: ${pageSize}, concurrency: ${concurrency}`)

	let fetched = 0
	let skipped = 0
	let totalRecords = 0
	let totalErrors = 0
	const failedCodes: string[] = []

	for (let cursor = startOID; cursor <= endOID; cursor += chunkSize) {
		const chunkEnd = Math.min(cursor + chunkSize - 1, endOID)
		const chunkName = `oids_${cursor}-${chunkEnd}`
		const chunkPath = chunkDir(`${chunkName}.ndjson`)
		const manifestPath = chunkDir(`${chunkName}.manifest.json`)

		// Idempotency: skip a chunk only when its manifest is marked complete.
		// Complete is set only after a clean fetch.
		if (await pathExists(chunkPath)) {
			const recorded = await readManifest<ChunkManifest>(manifestPath)

			if (recorded?.complete) {
				skipped++

				continue
			}
		}

		report?.(`  Fetching ${chunkName} ...`)
		const t0 = Date.now()
		const { recordCount, errors } = await fetchChunk(chunkPath, cursor, chunkEnd, pageSize, concurrency, report)
		const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
		const bytes = (await statPath(chunkPath)).size
		const sha = await sha256File(chunkPath)

		const manifest: ChunkManifest = {
			source_url: FEATURE_SERVICE_URL,
			oid_range: [cursor, chunkEnd],
			downloaded_at: new Date().toISOString(),
			filename: `${chunkName}.ndjson`,
			sha256: sha,
			bytes,
			record_count: recordCount,
			page_errors: errors,
			complete: errors === 0,
		}

		await writeManifest(manifestPath, manifest)

		const status = errors === 0 ? "✓" : `⚠ ${errors} page errors`

		report?.(
			`    ${status}  ${recordCount.toLocaleString()} records in ${elapsed}s  (${(bytes / 1024 / 1024).toFixed(1)} MB)`
		)

		fetched++
		totalRecords += recordCount
		totalErrors += errors

		if (errors > 0) {
			failedCodes.push(chunkName)
		}
	}

	report?.(`=== featureserver summary ===`)
	report?.(`chunks fetched: ${fetched}  skipped: ${skipped}`)
	report?.(`total records: ${totalRecords.toLocaleString()}`)
	report?.(`page errors:   ${totalErrors}`)
	report?.(`output:        ${chunkDir}`)

	// `failed` counts page errors and `failedCodes` records the dirty chunks.
	return { fetched, skipped, failed: totalErrors, failedCodes }
}

/**
 * The archive's file name on disk.
 * The download URL can name a media type rather than a file.
 */
const BULK_ARCHIVE = "nad.zip"

/**
 * The extracted member the conversion reads: the release's one large delimited text file.
 */
const BULK_TEXT_MEMBER = /\.(?:txt|csv)$/iu

/**
 * Downloads the bulk archive, extracts its text, and converts it to Parquet sorted by state and county.
 *
 * Each step keeps its output when the step before it is unchanged.
 * An archive whose manifest records the same URL and whose hash still matches is
 * not downloaded again, extracted members already on disk are kept, and the Parquet
 * file is kept while its record holds the same archive hash.
 *
 * An interrupted download resumes from its `.part` file when the host honors
 * byte ranges, and starts over when it does not.
 */
async function bulkMode(options: FetchNADOptions, report?: (line: string) => void): Promise<FetchSummary> {
	if (!options.nadURL) {
		throw new Error(
			`bulk mode requires --nad-url. Akamai protects the DOT page; ` +
				`visit https://www.transportation.gov/gis/national-address-database in a browser, ` +
				`accept the disclaimer, and re-run with the download link.`
		)
	}

	const url = options.nadURL
	const bulkDir = options.outRoot(SLUG, "bulk")
	const archivePath = bulkDir(BULK_ARCHIVE)
	const manifestPath = bulkDir("MANIFEST.json")

	await makeDirectories(bulkDir)
	report?.(`=== ${SLUG} / bulk`)

	const recorded = await readManifest<SourceManifest>(manifestPath)
	let sha256: string

	if (
		recorded?.source_url === url &&
		(await pathExists(archivePath)) &&
		(await sha256File(archivePath)) === recorded.sha256
	) {
		sha256 = recorded.sha256
		report?.(`  archive current: ${ByteFormatter.formatIEC(recorded.bytes)} sha256=${sha256}`)
	} else {
		const partialPath = `${archivePath}.part`
		const resumeFrom = (await tryStat(partialPath))?.size ?? 0

		const download = (from: number) =>
			streamToDisk({
				url,
				destination: archivePath,
				context: SLUG,
				partialPath,
				retainPartial: true,
				...(from ? { resumeFrom: from } : {}),
				onProgress: (line) => report?.(`  ${line}`),
			})

		const bytes = await download(resumeFrom).catch((error: unknown) => {
			if (!(error instanceof ResumeRefusedError)) throw error

			report?.(`  ${error.message}; downloading from the start`)

			return download(0)
		})

		sha256 = await sha256File(archivePath)

		await writeManifest(manifestPath, {
			source_url: url,
			downloaded_at: new Date().toISOString(),
			filename: BULK_ARCHIVE,
			sha256,
			bytes,
		} satisfies SourceManifest)

		report?.(`  ✓ ${ByteFormatter.formatIEC(bytes)} sha256=${sha256}`)
	}

	const extracted = await extractZipEntries(archivePath, bulkDir("extracted"), { skipExisting: true })
	const member = extracted.find((name) => BULK_TEXT_MEMBER.test(name))

	if (!member) {
		throw new Error(`${SLUG}: the archive holds no delimited text file (members: ${extracted.join(", ")})`)
	}

	const parquetPath = bulkDir(`${member.replace(/\.[^.]+$/u, "").replaceAll("/", "_")}.parquet`)

	const { record, converted } = await convertNADToParquet({
		textPath: bulkDir("extracted", member),
		parquetPath,
		sourceSHA256: sha256,
		member,
		report,
	})

	report?.(`  ${converted ? "✓ wrote" : "kept"} ${parquetPath}: ${record.rows.toLocaleString()} rows`)

	return { fetched: converted ? 1 : 0, skipped: converted ? 0 : 1, failed: 0, failedCodes: [] }
}

export async function fetchNAD(options: FetchNADOptions, report?: (line: string) => void): Promise<FetchSummary> {
	const mode = options.mode ?? "featureserver"

	if (mode === "featureserver") {
		return featureserverMode(options, report)
	}

	if (mode === "bulk") {
		return bulkMode(options, report)
	}

	throw new Error(`unknown mode "${String(mode)}" (expected featureserver|bulk)`)
}
