#!/usr/bin/env npx tsx
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Fetch the US DOT National Address Database (NAD) — ~97 million structured US address-point
 *   records aggregated from state and local authorities. Source for the `usgov-nad` adapter (#30).
 *   US Public Domain (17 U.S.C. § 105).
 *
 *   Replaces the bash `fetch-sources/fetch-nad.sh` with a TypeScript pipeline matching the style of
 *   the other corpus scripts (ingest-csv, run-corpus-build). Adds:
 *
 *   - Bounded per-chunk page concurrency (4× speedup at safe pressure)
 *   - 5× larger page size (5 000 vs. bash's 2 000) — fewer round-trips per chunk
 *   - Honest `complete: true` flag: only set when every page in the chunk fetched cleanly
 *   - Built-in fetch with gzip/brotli decompression (no curl + Python subprocess tax)
 *   - Per-chunk manifest with sha256 + record count + error count
 *
 *   ## Source layout
 *
 *   The ArcGIS FeatureServer is the only fully-automated path. As of 2026-05:
 *
 *   - **`bulk`** mode requires a pre-signed S3 URL (Akamai blocks scripted curl on the DOT page). Pass
 *       `NAD_URL=<presigned>` from a browser visit to
 *       [https://www.transportation.gov/gis/national-address-database](https://www.transportation.gov/gis/national-address-database).
 *   - **`featureserver`** mode (default) pages the live FeatureService via OBJECTID ranges, writing
 *       NDJSON chunks into `$OUT_ROOT/usgov-nad/featureserver/`.
 *
 *   ## Usage
 *
 *   ```sh
 *   OUT_ROOT=/mnt/playpen/mailwoman-data/corpus/sources \
 *   npx tsx packages/corpus/scripts/fetch-nad.ts
 *
 *   # Resume from an OID
 *   npx tsx packages/corpus/scripts/fetch-nad.ts --start-oid 34400001
 *
 *   # Increase concurrency on a fast link
 *   npx tsx packages/corpus/scripts/fetch-nad.ts --concurrency 8 --page-size 10000
 * ```
 *
 *   ## Flags
 *
 *   - `--out-root <path>` (env `OUT_ROOT`) — destination root; default `./data/corpus/sources`
 *   - `--mode bulk|featureserver` (env `NAD_MODE`) — fetch strategy; default `featureserver`
 *   - `--nad-url <url>` (env `NAD_URL`) — pre-signed S3 URL for bulk mode
 *   - `--chunk-size <n>` (env `FS_CHUNK_SIZE`) — records per output file; default `100000`
 *   - `--page-size <n>` (env `FS_PAGE_SIZE`) — records per HTTP request; default `5000`
 *   - `--concurrency <n>` (env `FS_CONCURRENCY`) — parallel page fetches within a chunk; default `4`
 *   - `--start-oid <n>` (env `FS_START_OID`) — start OBJECTID; default `1`
 *   - `--end-oid <n>` (env `FS_END_OID`) — stop before this OID; default = total count
 */

///<reference types="node" />

import { createHash } from "node:crypto"
import { existsSync, mkdirSync, statSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { parseArgs } from "node:util"

import { $public } from "@mailwoman/core/env"

const SLUG = "usgov-nad"
const FEATURE_SERVICE_URL =
	"https://services.arcgis.com/xOi1kZaI0eWDREZv/ArcGIS/rest/services/Address_Points_from_National_Address_Database_view/FeatureServer/0"

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

function envInt(name: string, fallback: number): number {
	const v = process.env[name]

	return v ? Number.parseInt(v, 10) : fallback
}

function parseCLIArgs() {
	const { values } = parseArgs({
		options: {
			"out-root": { type: "string", default: $public.OUT_ROOT ?? "data/corpus/sources" },
			mode: { type: "string", default: $public.NAD_MODE ?? "featureserver" },
			"nad-url": { type: "string", default: $public.NAD_URL },
			"chunk-size": { type: "string", default: String(envInt("FS_CHUNK_SIZE", 100_000)) },
			"page-size": { type: "string", default: String(envInt("FS_PAGE_SIZE", 5_000)) },
			concurrency: { type: "string", default: String(envInt("FS_CONCURRENCY", 4)) },
			"start-oid": { type: "string", default: String(envInt("FS_START_OID", 1)) },
			"end-oid": { type: "string", default: $public.FS_END_OID },
		},
	})

	return {
		outRoot: values["out-root"]!,
		mode: values.mode!,
		nadURL: values["nad-url"],
		chunkSize: Number.parseInt(values["chunk-size"]!, 10),
		pageSize: Number.parseInt(values["page-size"]!, 10),
		concurrency: Number.parseInt(values.concurrency!, 10),
		startOid: Number.parseInt(values["start-oid"]!, 10),
		endOid: values["end-oid"] ? Number.parseInt(values["end-oid"], 10) : undefined,
	}
}

async function sha256OfFile(path: string): Promise<string> {
	const hash = createHash("sha256")
	hash.update(await readFile(path))

	return hash.digest("hex")
}

async function fetchPage(startOid: number, endOid: number, pageSize: number): Promise<unknown[]> {
	const url = new URL(`${FEATURE_SERVICE_URL}/query`)
	url.searchParams.set("where", `OBJECTID BETWEEN ${startOid} AND ${endOid}`)
	url.searchParams.set("outFields", "*")
	url.searchParams.set("f", "json")
	url.searchParams.set("resultRecordCount", String(pageSize))

	const res = await fetch(url, {
		headers: { "Accept-Encoding": "gzip, br" },
		signal: AbortSignal.timeout(120_000),
	})

	if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} on OID ${startOid}-${endOid}`)
	const data = (await res.json()) as { features?: Array<{ attributes: unknown }>; error?: { message: string } }

	if (data.error) throw new Error(`ArcGIS error on OID ${startOid}-${endOid}: ${data.error.message}`)

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
 */
async function fetchChunk(
	chunkPath: string,
	chunkStart: number,
	chunkEnd: number,
	pageSize: number,
	concurrency: number
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
				process.stderr.write(`    ✗ page ${s}-${e}: ${(err as Error).message}\n`)
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

async function featureserverMode(opts: ReturnType<typeof parseCLIArgs>): Promise<void> {
	const chunkDir = join(opts.outRoot, SLUG, "featureserver")
	mkdirSync(chunkDir, { recursive: true })

	process.stderr.write(`=== ${SLUG} / featureserver\n`)
	process.stderr.write(`  Discovering record count ...\n`)
	const totalCount = await discoverTotalCount()
	const endOid = opts.endOid ?? totalCount
	process.stderr.write(`  Total records: ${totalCount.toLocaleString()}\n`)
	process.stderr.write(`  OID range: ${opts.startOid.toLocaleString()} .. ${endOid.toLocaleString()}\n`)
	process.stderr.write(
		`  Chunk size: ${opts.chunkSize}, page size: ${opts.pageSize}, concurrency: ${opts.concurrency}\n\n`
	)

	let fetched = 0
	let skipped = 0
	let totalRecords = 0
	let totalErrors = 0

	for (let cursor = opts.startOid; cursor <= endOid; cursor += opts.chunkSize) {
		const chunkEnd = Math.min(cursor + opts.chunkSize - 1, endOid)
		const chunkName = `oids_${cursor}-${chunkEnd}`
		const chunkPath = join(chunkDir, `${chunkName}.ndjson`)
		const manifestPath = join(chunkDir, `${chunkName}.manifest.json`)

		// Idempotency: skip a chunk only if it's marked complete (the bash version's bug was
		// marking complete on partial-failure runs; we now only set complete after a clean fetch).
		if (existsSync(manifestPath) && existsSync(chunkPath)) {
			try {
				const m = JSON.parse(await readFile(manifestPath, "utf8")) as ChunkManifest

				if (m.complete) {
					skipped++
					continue
				}
			} catch {
				// fall through and re-fetch
			}
		}

		process.stderr.write(`  Fetching ${chunkName} ...\n`)
		const t0 = Date.now()
		const { recordCount, errors } = await fetchChunk(chunkPath, cursor, chunkEnd, opts.pageSize, opts.concurrency)
		const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
		const bytes = statSync(chunkPath).size
		const sha = await sha256OfFile(chunkPath)

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
		await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n")

		const status = errors === 0 ? "✓" : `⚠ ${errors} page errors`
		process.stderr.write(
			`    ${status}  ${recordCount.toLocaleString()} records in ${elapsed}s  (${(bytes / 1024 / 1024).toFixed(1)} MB)\n`
		)
		fetched++
		totalRecords += recordCount
		totalErrors += errors
	}

	process.stderr.write(`\n=== featureserver summary ===\n`)
	process.stderr.write(`chunks fetched: ${fetched}  skipped: ${skipped}\n`)
	process.stderr.write(`total records: ${totalRecords.toLocaleString()}\n`)
	process.stderr.write(`page errors:   ${totalErrors}\n`)
	process.stderr.write(`output:        ${chunkDir}\n`)

	if (totalErrors > 0) {
		process.exitCode = 1
	}
}

async function bulkMode(opts: ReturnType<typeof parseCLIArgs>): Promise<void> {
	if (!opts.nadURL) {
		process.stderr.write(
			`error: bulk mode requires --nad-url (or NAD_URL env). The DOT page is Akamai-gated;\n` +
				`visit https://www.transportation.gov/gis/national-address-database in a browser,\n` +
				`accept the disclaimer, and re-run with the pre-signed S3 URL.\n`
		)
		process.exitCode = 2

		return
	}
	const destDir = join(opts.outRoot, SLUG)
	mkdirSync(destDir, { recursive: true })
	const filename = new URL(opts.nadURL).pathname.split("/").pop() ?? "NAD.zip"
	const destPath = join(destDir, filename)

	process.stderr.write(`=== ${SLUG} / ${filename}\n`)
	process.stderr.write(`  URL: ${opts.nadURL.slice(0, 100)}${opts.nadURL.length > 100 ? "…" : ""}\n`)

	const res = await fetch(opts.nadURL, { signal: AbortSignal.timeout(3 * 3600 * 1000) })

	if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} on bulk download`)
	const { writeFile: writeStream } = await import("node:fs/promises")
	const buf = Buffer.from(await res.arrayBuffer())
	await writeStream(destPath, buf)

	const bytes = buf.length
	const sha = await sha256OfFile(destPath)
	await writeFile(
		join(destDir, "MANIFEST.json"),
		JSON.stringify(
			{
				source_url: opts.nadURL,
				downloaded_at: new Date().toISOString(),
				filename,
				sha256: sha,
				bytes,
			},
			null,
			2
		) + "\n"
	)
	process.stderr.write(`  ✓ ${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB  sha256=${sha}\n`)
}

async function main(): Promise<void> {
	const opts = parseCLIArgs()

	if (opts.mode === "featureserver") {
		await featureserverMode(opts)
	} else if (opts.mode === "bulk") {
		await bulkMode(opts)
	} else {
		process.stderr.write(`error: unknown mode "${opts.mode}" (expected featureserver|bulk)\n`)
		process.exitCode = 2
	}
}

main().catch((err: Error) => {
	process.stderr.write(`fatal: ${err.message}\n${err.stack}\n`)
	process.exitCode = 1
})
