#!/usr/bin/env npx tsx
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
 *   CC-BY-SA, CC-SA) are dropped at ingest by default. This script downloads the raw collection; the
 *   adapter does the license gating.
 *
 *   Replaces the bash `fetch-sources/fetch-openaddresses.sh` with a TypeScript pipeline matching the
 *   style of the other corpus scripts (fetch-nad, ingest-csv, run-corpus-build). Native `fetch`
 *   streams the download to disk (no curl + Python subprocess tax); `zx` keeps the genuine shell ops
 *   it still needs (`file` magic detection + `gunzip` decompression, both nice/ionice-deprioritized).
 *
 *   ## Authentication note (2026-05-18)
 *
 *   The batch.openaddresses.io download endpoint now requires a registered account. Downloads are
 *   still free at the "basic" tier (GeoJSON+LD output).
 *
 *   1. Register at https://batch.openaddresses.io/register
 *   2. Log in and go to Profile → "Create Token"
 *   3. Export the token: `export OA_BATCH_TOKEN=<your-token>`
 *   4. Re-run this script.
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
 *   # With token (preferred):
 *   OA_BATCH_TOKEN=<token> \
 *     OUT_ROOT=/mnt/playpen/mailwoman-data/corpus/sources \
 *     npx tsx corpus/scripts/fetch-sources/fetch-openaddresses.ts --country ca
 *
 *   # Default country: ca. Supports any OA country code (us-west, us-south, fr, …)
 *   OA_BATCH_TOKEN=<token> npx tsx corpus/scripts/fetch-sources/fetch-openaddresses.ts
 *
 *   # Without token (will detect + print instructions then exit):
 *   npx tsx corpus/scripts/fetch-sources/fetch-openaddresses.ts --country ca
 * ```
 *
 *   ## Flags
 *
 *   - `--country <code>` (also positional `<code>`) — OA country collection; default `ca`
 *   - `--out-root <path>` (env `OUT_ROOT`) — destination root; default `<repo-root>/data/corpus/sources`
 *   - env `OA_BATCH_TOKEN` — required bearer token (see auth note above)
 */

///<reference types="node" />

import { createHash } from "node:crypto"
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { parseArgs } from "node:util"

import { $ } from "zx"

$.verbose = false

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

interface OaCollection {
	name?: string
	id?: number
	human?: string
	size?: number
}

function parseCLIArgs() {
	const { values, positionals } = parseArgs({
		allowPositionals: true,
		options: {
			country: { type: "string" },
			"out-root": { type: "string", default: process.env.OUT_ROOT },
		},
	})

	return {
		// Positional first arg accepted for backwards-compat: `script ca`.
		country: values.country ?? positionals[0] ?? "ca",
		outRoot: values["out-root"],
		token: process.env.OA_BATCH_TOKEN,
	}
}

/** Repo-root toplevel, mirroring the bash default `$(git rev-parse --show-toplevel)/data/corpus/sources`. */
async function gitToplevel(): Promise<string> {
	return (await $`git rev-parse --show-toplevel`).stdout.trim()
}

/** Stream-hash a file with sha256 (memory-safe for the multi-GB collection). */
async function sha256OfFile(path: string): Promise<string> {
	const hash = createHash("sha256")
	await pipeline(createReadStream(path), hash)

	return hash.digest("hex")
}

/** Stream-count newlines, matching `wc -l` (memory-safe for the multi-GB collection). */
async function countLines(path: string): Promise<number> {
	let count = 0

	for await (const chunk of createReadStream(path) as AsyncIterable<Buffer>) {
		for (let i = 0; i < chunk.length; i++) {
			if (chunk[i] === 0x0a) count++
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

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Mirror curl's `--retry` policy: only transient HTTP statuses are worth a retry. */
function isTransientStatus(status: number): boolean {
	return status === 408 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504
}

interface DownloadOpts {
	headers?: Record<string, string>
	timeoutMs: number
	retries: number
	retryDelayMs: number
}

/**
 * Stream an HTTP download to disk, returning the final HTTP status (0 on network error after retries). Follows
 * redirects (the OA download endpoint 302s to a pre-signed S3 URL). Replaces the bash `curl -fsSL -o`; the `nice -n 15
 * ionice -c 3` priority wrappers do not translate to an in-process fetch and are dropped here.
 */
async function downloadToFile(url: string, dest: string, opts: DownloadOpts): Promise<number> {
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
				await delay(opts.retryDelayMs)
				continue
			}

			return res.status
		} catch {
			if (attempt < opts.retries) {
				await delay(opts.retryDelayMs)
				continue
			}

			return 0
		}
	}

	return 0
}

async function main(): Promise<void> {
	const cli = parseCLIArgs()
	const country = cli.country
	const outRoot = cli.outRoot ?? join(await gitToplevel(), "data", "corpus", "sources")

	const destDir = join(outRoot, "openaddresses", country)
	const manifestPath = join(destDir, "MANIFEST.json")
	const outputFile = join(destDir, "collection.geojsonl")

	process.stdout.write(`=== fetch-openaddresses: country=${country}\n`)
	process.stdout.write(`    dest: ${destDir}\n`)

	mkdirSync(destDir, { recursive: true })

	// -------------------------------------------------------------------------
	// Authentication check
	// -------------------------------------------------------------------------
	if (!cli.token) {
		process.stderr.write(`
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
  5. Re-run this script.

The Canada collection (ca) is ~2 GiB compressed / ~7 GiB uncompressed
(estimated), so budget ~20–45 minutes at typical cloud-to-host bandwidth.

`)
		process.exit(1)
	}

	const token = cli.token

	// -------------------------------------------------------------------------
	// Determine collection ID
	// -------------------------------------------------------------------------
	let collectionId = OA_COLLECTION_IDS[country]

	if (collectionId === undefined) {
		process.stdout.write(`Unknown country code '${country}'. Fetching collection list to find ID...\n`)
		const res = await fetch(`${OA_BASE}/api/collections`, {
			headers: { Authorization: `Bearer ${token}`, "Accept-Encoding": "gzip, br" },
			signal: AbortSignal.timeout(30_000),
		})

		if (!res.ok) {
			process.stderr.write(`ERROR: GET /api/collections returned HTTP ${res.status}.\n`)
			process.exit(1)
		}

		const collections = (await res.json()) as OaCollection[]
		const match = collections.find((item) => item.name === country)

		if (match?.id === undefined) {
			process.stderr.write(`ERROR: Could not find a collection named '${country}' in GET /api/collections.\n`)
			process.stderr.write(`Available collections:\n`)

			for (const item of collections) {
				const size = (item.size ?? 0).toLocaleString()
				process.stderr.write(
					`  ${(item.name ?? "").padEnd(20)}  id=${item.id}  ${item.human ?? ""}  size=${size} bytes\n`
				)
			}

			process.exit(1)
		}

		collectionId = match.id
		process.stdout.write(`  Found collection id=${collectionId} for '${country}'\n`)
	}

	// -------------------------------------------------------------------------
	// Download via the collections download endpoint (302s to S3)
	// -------------------------------------------------------------------------
	process.stdout.write(`  Resolving download URL for collection id=${collectionId}...\n`)
	process.stdout.write(`  Attempting authenticated download...\n`)

	const tmpGz = join(destDir, "collection.geojsonl.gz.tmp")
	const tmpRaw = join(destDir, "collection.geojsonl.tmp")
	const sourceURL = `${OA_BASE}/api/collections/${collectionId}/download`

	let httpStatus = await downloadToFile(sourceURL, tmpGz, {
		headers: { Authorization: `Bearer ${token}` },
		timeoutMs: 7_200_000,
		retries: 3,
		retryDelayMs: 30_000,
	})

	if (httpStatus !== 200) {
		// Try the geojsonl.gz directly with token as query param (alternate URL shape).
		httpStatus = await downloadToFile(`${OA_BASE}/api/collections/${collectionId}/geojsonl.gz?token=${token}`, tmpGz, {
			timeoutMs: 7_200_000,
			retries: 3,
			retryDelayMs: 30_000,
		})
	}

	if (httpStatus !== 200) {
		rmSync(tmpGz, { force: true })
		process.stderr.write(`
ERROR: Download returned HTTP ${httpStatus}.

Likely causes:
  1. OA_BATCH_TOKEN is invalid or expired — re-create it at Profile → Tokens.
  2. The collection download endpoint URL has changed (this script was written
     against the 2026-05-18 batch.openaddresses.io API; it may need updating).
  3. Network error or CDN outage.

Manual download (after logging in to batch.openaddresses.io):
  - Navigate to https://batch.openaddresses.io/collection/${collectionId}
  - Click "GeoJSON+LD" to download the collection.
  - Save as: ${outputFile}
  - Then re-run this script with SKIP_DOWNLOAD=1 to generate the MANIFEST.

URL tried: ${OA_BASE}/api/collections/${collectionId}/download

`)
		process.exit(1)
	}

	// -------------------------------------------------------------------------
	// Decompress if the downloaded file is gzipped
	// -------------------------------------------------------------------------
	const fileMagic = (await $`file --brief ${tmpGz}`.nothrow()).stdout

	if (/gzip|compressed/i.test(fileMagic)) {
		process.stdout.write(`  Decompressing gzip archive...\n`)
		await $`nice -n 15 ionice -c 3 gunzip -c ${tmpGz} > ${tmpRaw}`
		rmSync(tmpGz, { force: true })
		renameSync(tmpRaw, outputFile)
	} else if (/JSON|ASCII|UTF-8/i.test(fileMagic)) {
		// Already line-delimited GeoJSON.
		renameSync(tmpGz, outputFile)
		rmSync(tmpRaw, { force: true })
	} else {
		// Unknown type — keep as-is and let the operator inspect.
		renameSync(tmpGz, outputFile)
		process.stderr.write(`  WARNING: Downloaded file type is '${fileMagic.trim()}' — may need manual decompression.\n`)
	}

	// -------------------------------------------------------------------------
	// Verify + write MANIFEST
	// -------------------------------------------------------------------------
	if (!existsSync(outputFile)) {
		process.stderr.write(`ERROR: Output file not found at ${outputFile} after download.\n`)
		process.exit(1)
	}

	const size = statSync(outputFile).size

	if (size < 10240) {
		process.stderr.write(`ERROR: File is suspiciously small (${size} bytes) — likely an error response.\n`)
		process.exit(1)
	}

	const sha = await sha256OfFile(outputFile)
	const rowCount = await countLines(outputFile)
	const downloadedAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z")

	const manifest = {
		source_url: sourceURL,
		collection_id: collectionId,
		country,
		filename: "collection.geojsonl",
		downloaded_at: downloadedAt,
		sha256: sha,
		bytes: size,
		row_count: rowCount,
		notes:
			"batch.openaddresses.io requires a free registered account for downloads. License is mixed per-row; use the openaddresses adapter with allowShareAlike=false (default) to filter Tier-C rows.",
	}
	await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n")

	process.stdout.write(`  ✓ ${humanBytes(size)}  rows=${rowCount}  sha256=${sha}\n`)
	process.stdout.write(`  MANIFEST written to ${manifestPath}\n`)
	process.stdout.write(`\n=== done\n`)
	process.stdout.write(`Feed to the adapter:\n`)
	process.stdout.write(`  npx mailwoman corpus run openaddresses \\\n`)
	process.stdout.write(`    --input ${outputFile} \\\n`)
	process.stdout.write(`    --country ${country.toUpperCase()} \\\n`)
	process.stdout.write(`    --output $OUT_ROOT\n`)
}

main().catch((err: Error) => {
	process.stderr.write(`fatal: ${err.message}\n${err.stack}\n`)
	process.exitCode = 1
})
