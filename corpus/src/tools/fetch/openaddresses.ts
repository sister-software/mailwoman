/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Fetch an OpenAddresses country collection from batch.openaddresses.io.
 *
 *   Source: https://batch.openaddresses.io
 *   License: MIXED — OpenAddresses aggregates hundreds of upstream sources with per-source licenses
 *   (CC-BY, CC0, PDDL, ODbL, CC-BY-SA, and proprietary attribution-only). The per-row LICENSE filter
 *   in the openaddresses adapter is essential for proprietary-weights training: Tier-C rows (ODbL,
 *   CC-BY-SA, CC-SA) are dropped at ingest by default. This module downloads the raw collection; the
 *   adapter does the license gating.
 *
 *   Native `fetch` streams the download to disk (no curl + Python subprocess tax);
 *   `node:child_process` keeps the genuine shell ops it still needs (`file` magic detection +
 *   `gunzip` decompression, both nice/ionice-deprioritized).
 *
 *   ## Authentication note (2026-05-18)
 *
 *   The batch.openaddresses.io download endpoint now requires a registered account. Downloads are
 *   still free at the "basic" tier (GeoJSON+LD output).
 *
 *   1. Register at https://batch.openaddresses.io/register
 *   2. Log in and go to Profile → "Create Token"
 *   3. Export the token: `export OA_BATCH_TOKEN=<your-token>`
 *   4. Re-run the command.
 *
 *   The collection URL pattern (verified 2026-05-18):
 *
 *   - `POST /api/login {username, password}` → `{token}`
 *   - `GET  /api/job/{job_id}/output/source.geojson.gz?token={token}`
 *
 *   Collections are downloaded as a combined GeoJSON.gz via:
 *
 *   - `GET  /api/collections/{collection_id}/download` (returns a redirect to S3)
 *
 *   Collection IDs discovered from `/api/collections`:
 *
 *   - `id=6  name="ca"  size=2044467556` (~1.9 GiB uncompressed, verified 2026-05-18)
 *
 *   ## Usage
 *
 *   ```sh
 *   # With token (preferred). Default country: ca. Supports any OA country code (us-west, fr, …)
 *   OA_BATCH_TOKEN=<token> mailwoman corpus fetch openaddresses --country ca \
 *     --out-root /mnt/playpen/mailwoman-data/corpus/sources
 *
 *   # Without token (will detect + print instructions, then report the failure):
 *   mailwoman corpus fetch openaddresses --country ca
 *   ```
 */

import { execFile, spawn } from "node:child_process"
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs"
import { join } from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { setTimeout as sleep } from "node:timers/promises"
import { promisify } from "node:util"

import { $private } from "@mailwoman/core/env"
import { sha256File } from "@mailwoman/core/utils"

import type { BaseFetchOptions, FetchSummary } from "./download.ts"
import { isTransientStatus, writeManifest } from "./download.ts"

const execFileAsync = promisify(execFile)

const OA_BASE = "https://batch.openaddresses.io"

/**
 * Collection IDs known as of 2026-05-18 (discovered via `GET /api/collections`). OA assigns stable integer IDs to each
 * country collection; re-check `GET /api/collections` if a new country is needed and the ID is unknown.
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
	/** OA country collection code. Default `ca`. */
	country?: string
}

interface OaCollection {
	name?: string
	id?: number
	human?: string
	size?: number
}

/** Stream-count newlines, matching `wc -l` (memory-safe for the multi-GB collection). */
async function countLines(path: string): Promise<number> {
	let count = 0

	for await (const chunk of createReadStream(path) as AsyncIterable<Buffer>) {
		for (let i = 0; i < chunk.length; i++) {
			if (chunk[i] === 0x0a) {
				count++
			}
		}
	}

	return count
}

function humanBytes(bytes: number): string {
	const units = ["B", "KiB", "MiB", "GiB", "TiB"]
	let value = bytes
	let unit = 0

	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024
		unit++
	}

	return `${value.toFixed(unit === 0 ? 0 : 1)}${units[unit]}`
}

interface StreamDownloadOpts {
	headers?: Record<string, string>
	timeoutMs: number
	retries: number
	retryDelayMs: number
}

/**
 * Stream an HTTP download to disk, returning the final HTTP status (0 on network error after retries). Follows
 * redirects (the OA download endpoint 302s to a pre-signed S3 URL).
 *
 * NOTE(phase1): kept local instead of the shared `downloadToFile` — this one streams a multi-GB body to disk (the
 * shared util buffers via `arrayBuffer()`) and returns the HTTP status instead of throwing, which the caller needs for
 * its two-URL fallback ladder.
 */
async function streamDownload(url: string, dest: string, opts: StreamDownloadOpts): Promise<number> {
	for (let attempt = 0; attempt <= opts.retries; attempt++) {
		try {
			const res = await fetch(url, {
				headers: opts.headers ?? {},
				redirect: "follow",
				signal: AbortSignal.timeout(opts.timeoutMs),
			})

			if (res.ok && res.body) {
				await pipeline(Readable.fromWeb(res.body), createWriteStream(dest))

				return res.status
			}

			if (attempt < opts.retries && isTransientStatus(res.status)) {
				await sleep(opts.retryDelayMs)
				continue
			}

			return res.status
		} catch {
			if (attempt < opts.retries) {
				await sleep(opts.retryDelayMs)
				continue
			}

			return 0
		}
	}

	return 0
}

/** Decompress `src` → `dest` with the same deprioritized subprocess the old fetcher used. */
async function gunzipToFile(src: string, dest: string): Promise<void> {
	const child = spawn("nice", ["-n", "15", "ionice", "-c", "3", "gunzip", "-c", src], {
		stdio: ["ignore", "pipe", "inherit"],
	})
	await pipeline(child.stdout!, createWriteStream(dest))
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

	const destDir = join(options.outRoot, "openaddresses", country)
	const manifestPath = join(destDir, "MANIFEST.json")
	const outputFile = join(destDir, "collection.geojsonl")

	const fail = (code: string): FetchSummary => ({ fetched: 0, skipped: 0, failed: 1, failedCodes: [code] })

	report?.(`=== fetch openaddresses: country=${country}`)
	report?.(`    dest: ${destDir}`)

	mkdirSync(destDir, { recursive: true })

	// -------------------------------------------------------------------------
	// Authentication check
	// -------------------------------------------------------------------------
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

	// -------------------------------------------------------------------------
	// Determine collection ID
	// -------------------------------------------------------------------------
	let collectionID = OA_COLLECTION_IDS[country]

	if (collectionID === undefined) {
		report?.(`Unknown country code '${country}'. Fetching collection list to find ID...`)
		const res = await fetch(`${OA_BASE}/api/collections`, {
			headers: { Authorization: `Bearer ${token}`, "Accept-Encoding": "gzip, br" },
			signal: AbortSignal.timeout(30_000),
		})

		if (!res.ok) {
			report?.(`ERROR: GET /api/collections returned HTTP ${res.status}.`)

			return fail(country)
		}

		const collections = (await res.json()) as OaCollection[]
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

	// -------------------------------------------------------------------------
	// Download via the collections download endpoint (302s to S3)
	// -------------------------------------------------------------------------
	report?.(`  Resolving download URL for collection id=${collectionID}...`)
	report?.(`  Attempting authenticated download...`)

	const tmpGz = join(destDir, "collection.geojsonl.gz.tmp")
	const tmpRaw = join(destDir, "collection.geojsonl.tmp")
	const sourceURL = `${OA_BASE}/api/collections/${collectionID}/download`

	let httpStatus = await streamDownload(sourceURL, tmpGz, {
		headers: { Authorization: `Bearer ${token}` },
		timeoutMs: 7_200_000,
		retries: 3,
		retryDelayMs: 30_000,
	})

	if (httpStatus !== 200) {
		// Try the geojsonl.gz directly with token as query param (alternate URL shape).
		httpStatus = await streamDownload(`${OA_BASE}/api/collections/${collectionID}/geojsonl.gz?token=${token}`, tmpGz, {
			timeoutMs: 7_200_000,
			retries: 3,
			retryDelayMs: 30_000,
		})
	}

	if (httpStatus !== 200) {
		rmSync(tmpGz, { force: true })
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

	// -------------------------------------------------------------------------
	// Decompress if the downloaded file is gzipped
	// -------------------------------------------------------------------------
	const fileMagic = (await execFileAsync("file", ["--brief", tmpGz]).catch(() => ({ stdout: "" }))).stdout

	if (/gzip|compressed/i.test(fileMagic)) {
		report?.(`  Decompressing gzip archive...`)
		await gunzipToFile(tmpGz, tmpRaw)
		rmSync(tmpGz, { force: true })
		renameSync(tmpRaw, outputFile)
	} else if (/JSON|ASCII|UTF-8/i.test(fileMagic)) {
		// Already line-delimited GeoJSON.
		renameSync(tmpGz, outputFile)
		rmSync(tmpRaw, { force: true })
	} else {
		// Unknown type — keep as-is and let the operator inspect.
		renameSync(tmpGz, outputFile)
		report?.(`  WARNING: Downloaded file type is '${fileMagic.trim()}' — may need manual decompression.`)
	}

	// -------------------------------------------------------------------------
	// Verify + write MANIFEST
	// -------------------------------------------------------------------------
	if (!existsSync(outputFile)) {
		report?.(`ERROR: Output file not found at ${outputFile} after download.`)

		return fail(country)
	}

	const size = statSync(outputFile).size

	if (size < 10240) {
		report?.(`ERROR: File is suspiciously small (${size} bytes) — likely an error response.`)

		return fail(country)
	}

	const sha = await sha256File(outputFile)
	const rowCount = await countLines(outputFile)
	const downloadedAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z")

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

	report?.(`  ✓ ${humanBytes(size)}  rows=${rowCount}  sha256=${sha}`)
	report?.(`  MANIFEST written to ${manifestPath}`)
	report?.(`=== done`)
	report?.(`Feed to the adapter:`)
	report?.(`  mailwoman corpus run openaddresses \\`)
	report?.(`    --input ${outputFile} \\`)
	report?.(`    --country ${country.toUpperCase()} \\`)
	report?.(`    --output ${options.outRoot}`)

	return { fetched: 1, skipped: 0, failed: 0, failedCodes: [] }
}
