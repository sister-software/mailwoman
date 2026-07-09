/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Fetch the US DOT National Address Database (NAD) — ~97 million structured US address-point
 *   records aggregated from state and local authorities. Source for the `usgov-nad` adapter (#30).
 *   US Public Domain (17 U.S.C. § 105).
 *
 *   - Bounded per-chunk page concurrency (4× speedup at safe pressure)
 *   - 5× larger page size (5 000 vs. the old bash fetcher's 2 000) — fewer round-trips per chunk
 *   - Honest `complete: true` flag: only set when every page in the chunk fetched cleanly
 *   - Built-in fetch with gzip/brotli decompression (no curl + Python subprocess tax)
 *   - Per-chunk manifest with sha256 + record count + error count
 *
 *   ## Source layout
 *
 *   The ArcGIS FeatureServer is the only fully-automated path. As of 2026-05:
 *
 *   - **`bulk`** mode requires a pre-signed S3 URL (Akamai blocks scripted curl on the DOT page). Pass
 *       `--nad-url <presigned>` from a browser visit to
 *       [https://www.transportation.gov/gis/national-address-database](https://www.transportation.gov/gis/national-address-database).
 *   - **`featureserver`** mode (default) pages the live FeatureService via OBJECTID ranges, writing
 *       NDJSON chunks into `<outRoot>/usgov-nad/featureserver/`.
 *
 *   ## Usage
 *
 *   ```sh
 *   mailwoman corpus fetch nad --out-root /mnt/playpen/mailwoman-data/corpus/sources
 *
 *   # Resume from an OID
 *   mailwoman corpus fetch nad --start-oid 34400001
 *
 *   # Increase concurrency on a fast link
 *   mailwoman corpus fetch nad --concurrency 8 --page-size 10000
 *   ```
 */

import { existsSync, mkdirSync, statSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"

import { sha256File } from "@mailwoman/core/utils"

import type { BaseFetchOptions, FetchSummary } from "./download.ts"
import { downloadToFile, readManifest, writeManifest } from "./download.ts"

const SLUG = "usgov-nad"
const FEATURE_SERVICE_URL =
	"https://services.arcgis.com/xOi1kZaI0eWDREZv/ArcGIS/rest/services/Address_Points_from_National_Address_Database_view/FeatureServer/0"

export interface FetchNADOptions extends BaseFetchOptions {
	/** Fetch strategy. Default `featureserver`. */
	mode?: "featureserver" | "bulk"
	/** Pre-signed S3 URL for bulk mode. */
	nadURL?: string
	/** Records per output file. Default `100000`. */
	chunkSize?: number
	/** Records per HTTP request. Default `5000`. */
	pageSize?: number
	/** Parallel page fetches within a chunk. Default `4`. */
	concurrency?: number
	/** Start OBJECTID. Default `1`. */
	startOID?: number
	/** Stop before this OID. Default = total count. */
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

async function fetchPage(startOID: number, endOID: number, pageSize: number): Promise<unknown[]> {
	const url = new URL(`${FEATURE_SERVICE_URL}/query`)
	url.searchParams.set("where", `OBJECTID BETWEEN ${startOID} AND ${endOID}`)
	url.searchParams.set("outFields", "*")
	url.searchParams.set("f", "json")
	url.searchParams.set("resultRecordCount", String(pageSize))

	const res = await fetch(url, {
		headers: { "Accept-Encoding": "gzip, br" },
		signal: AbortSignal.timeout(120_000),
	})

	if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} on OID ${startOID}-${endOID}`)
	const data = (await res.json()) as { features?: Array<{ attributes: unknown }>; error?: { message: string } }

	if (data.error) throw new Error(`ArcGIS error on OID ${startOID}-${endOID}: ${data.error.message}`)

	return (data.features ?? []).map((f) => f.attributes)
}

async function discoverTotalCount(): Promise<number> {
	const url = new URL(`${FEATURE_SERVICE_URL}/query`)
	url.searchParams.set("where", "1=1")
	url.searchParams.set("returnCountOnly", "true")
	url.searchParams.set("f", "json")
	const res = await fetch(url, { signal: AbortSignal.timeout(30_000) })

	if (!res.ok) throw new Error(`Failed to discover NAD record count: HTTP ${res.status}`)
	const data = (await res.json()) as { count?: number }

	if (typeof data.count !== "number") throw new Error("NAD count query returned no count field")

	return data.count
}

/**
 * Fetch a single chunk by paging through its OID range with bounded concurrency. Returns the count of records written
 * and the count of pages that errored. The caller decides whether to mark the chunk complete based on errors === 0.
 *
 * NOTE(phase1): this is a JSON API pager, not a file download — the shared `downloadToFile` doesn't apply here.
 */
async function fetchChunk(
	chunkPath: string,
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

	// Run bounded-concurrency page fetches. Results indexed by page slot for in-order write.
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
			} catch (err) {
				pageResults[slot]!.error = err as Error
				report?.(`    ✗ page ${s}-${e}: ${(err as Error).message}`)
			}
		}
	})
	await Promise.all(workers)

	// Single-writer phase — write all pages in OID order to keep NDJSON deterministic.
	const lines: string[] = []
	let errors = 0

	for (const { rows, error } of pageResults) {
		if (error) {
			errors++
			continue
		}

		for (const row of rows) {
			lines.push(JSON.stringify(row))
		}
	}
	await writeFile(chunkPath, lines.length === 0 ? "" : lines.join("\n") + "\n")

	return { recordCount: lines.length, errors }
}

async function featureserverMode(options: FetchNADOptions, report?: (line: string) => void): Promise<FetchSummary> {
	const chunkSize = options.chunkSize ?? 100_000
	const pageSize = options.pageSize ?? 5_000
	const concurrency = options.concurrency ?? 4
	const startOID = options.startOID ?? 1

	const chunkDir = join(options.outRoot, SLUG, "featureserver")
	mkdirSync(chunkDir, { recursive: true })

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
		const chunkPath = join(chunkDir, `${chunkName}.ndjson`)
		const manifestPath = join(chunkDir, `${chunkName}.manifest.json`)

		// Idempotency: skip a chunk only if it's marked complete (the bash version's bug was
		// marking complete on partial-failure runs; we now only set complete after a clean fetch).
		if (existsSync(chunkPath)) {
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
		const bytes = statSync(chunkPath).size
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

	// `failed` counts page errors (the old exit-1 condition), `failedCodes` names the dirty chunks.
	return { fetched, skipped, failed: totalErrors, failedCodes }
}

async function bulkMode(options: FetchNADOptions, report?: (line: string) => void): Promise<FetchSummary> {
	if (!options.nadURL) {
		throw new Error(
			`bulk mode requires --nad-url. The DOT page is Akamai-gated; ` +
				`visit https://www.transportation.gov/gis/national-address-database in a browser, ` +
				`accept the disclaimer, and re-run with the pre-signed S3 URL.`
		)
	}
	const destDir = join(options.outRoot, SLUG)
	mkdirSync(destDir, { recursive: true })
	const filename = new URL(options.nadURL).pathname.split("/").pop() ?? "NAD.zip"
	const destPath = join(destDir, filename)

	report?.(`=== ${SLUG} / ${filename}`)
	report?.(`  URL: ${options.nadURL.slice(0, 100)}${options.nadURL.length > 100 ? "…" : ""}`)

	const { bytes } = await downloadToFile({ url: options.nadURL, dest: destPath, timeoutMs: 3 * 3600 * 1000, report })

	const sha = await sha256File(destPath)
	await writeManifest(join(destDir, "MANIFEST.json"), {
		source_url: options.nadURL,
		downloaded_at: new Date().toISOString(),
		filename,
		sha256: sha,
		bytes,
	})
	report?.(`  ✓ ${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB  sha256=${sha}`)

	return { fetched: 1, skipped: 0, failed: 0, failedCodes: [] }
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
