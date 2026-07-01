#!/usr/bin/env npx tsx
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Re-fetch the IMLS Public Libraries Survey (PLS) outlet-level data. Each US public library branch
 *   (outlet) is one row, ~17K rows with address fields. Source for the planned `usgov-imls-pls`
 *   adapter. US Public Domain (federal statistical survey).
 *
 *   The FY 2023 release is the most current as of 2026-05. IMLS ships a single ZIP containing CSV,
 *   SAS, and SPSS variants. We extract the outlet-level CSV (pls_fy*_outlet*.csv or similar) and
 *   discard the rest. The administrative-entity (system-level) CSV is intentionally skipped — it has
 *   no per-branch address detail.
 *
 *   Replaces the bash `fetch-sources/fetch-imls-pls.sh` with a TypeScript pipeline matching the style
 *   of the other corpus scripts (fetch-nad, ingest-csv): Node's built-in fetch (gzip/brotli) and
 *   `node:crypto` sha256 instead of curl + sha256sum. The ZIP is unpacked with `unzip` via zx (no
 *   clean Node equivalent for member listing + selective extraction).
 *
 *   ## Usage
 *
 *   ```sh
 *   OUT_ROOT=/mnt/playpen/mailwoman-data/corpus/sources \
 *     npx tsx packages/corpus/scripts/fetch-sources/fetch-imls-pls.ts
 *   ```
 *
 *   Defaults to writing under `./data/corpus/sources/` in the repo root. Idempotent: if dest CSV
 *   exists and sha matches MANIFEST, skips download.
 *
 *   ## Flags
 *
 *   - `--out-root <path>` (env `OUT_ROOT`) — destination root; default `<repo-root>/data/corpus/sources`
 */

///<reference types="node" />

import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, statSync } from "node:fs"
import { readFile, rm, writeFile } from "node:fs/promises"
import { basename, join } from "node:path"
import { parseArgs } from "node:util"

import { $public } from "@mailwoman/core/env"
import { $ } from "zx"

// The PLS FY 2023 bulk CSV ZIP (most recent as of 2026-05).
// If IMLS publishes a newer year, update this URL.
const ZIP_URL = "https://www.imls.gov/sites/default/files/2025-08/pls_fy2023_csv.zip"
const SLUG = "usgov-imls-pls"

interface SourceManifest {
	source_url: string
	downloaded_at: string
	filename: string
	sha256: string
	bytes: number
}

/** Mirror the bash default of `$(git rev-parse --show-toplevel)/data/corpus/sources`. */
function repoRootDataSources(): string {
	const top = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim()

	return join(top, "data", "corpus", "sources")
}

async function sha256OfFile(path: string): Promise<string> {
	const hash = createHash("sha256")
	hash.update(await readFile(path))

	return hash.digest("hex")
}

async function downloadToFile(url: string, dest: string, timeoutMs: number): Promise<number> {
	const res = await fetch(url, {
		headers: { "Accept-Encoding": "gzip, br" },
		signal: AbortSignal.timeout(timeoutMs),
	})

	if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} on ${url}`)
	await writeFile(dest, Buffer.from(await res.arrayBuffer()))

	return statSync(dest).size
}

/** Return the filenames listed inside a ZIP (the trailing column of each `unzip -l` row). */
async function listZipEntries(zipPath: string): Promise<string[]> {
	const listing = await $`unzip -l ${zipPath}`

	return listing.stdout
		.split("\n")
		.map((line) => line.trim().split(/\s+/).pop() ?? "")
		.filter((name) => name.length > 0)
}

function parseCLIArgs() {
	const { values } = parseArgs({
		options: {
			"out-root": { type: "string", default: $public.OUT_ROOT },
		},
	})

	return {
		outRoot: values["out-root"] ?? repoRootDataSources(),
	}
}

async function main(): Promise<void> {
	$.verbose = false

	const { outRoot } = parseCLIArgs()
	const destDir = join(outRoot, SLUG)
	mkdirSync(destDir, { recursive: true })

	const zipDest = join(destDir, basename(ZIP_URL))
	const manifestPath = join(destDir, "MANIFEST.json")

	process.stderr.write(`=== ${SLUG}\n`)

	// ------------------------------------------------------------------
	// Idempotency check: if outlet CSV already exists and sha matches, skip.
	// ------------------------------------------------------------------
	if (existsSync(manifestPath)) {
		try {
			const recorded = JSON.parse(await readFile(manifestPath, "utf8")) as Partial<SourceManifest>

			if (recorded.sha256 && recorded.filename) {
				const recordedPath = join(destDir, recorded.filename)

				if (existsSync(recordedPath) && (await sha256OfFile(recordedPath)) === recorded.sha256) {
					process.stderr.write("  ✓ Already current (sha256 matches MANIFEST) — skipping download.\n")

					return
				}
			}
		} catch {
			// Fall through and re-fetch.
		}
	}

	// ------------------------------------------------------------------
	// Download ZIP
	// ------------------------------------------------------------------
	process.stderr.write(`  Downloading ${ZIP_URL} ...\n`)
	const zipSize = await downloadToFile(ZIP_URL, zipDest, 600_000)
	process.stderr.write(`  Downloaded: ${(zipSize / 1024 / 1024).toFixed(1)} MB\n`)

	if (zipSize < 1024) {
		process.stderr.write(`  ✗ Response too small (${zipSize} bytes) — probable error page\n`)
		process.exitCode = 1

		return
	}

	// ------------------------------------------------------------------
	// Discover the outlet-level CSV inside the ZIP.
	// Outlet files match: pls_fy*outlet*.csv (case-insensitive)
	// Administrative-entity files match: pls_fy*ae*.csv — we skip those.
	// ------------------------------------------------------------------
	process.stderr.write("  Inspecting ZIP contents ...\n")
	const entries = await listZipEntries(zipDest)

	let csvName = entries.find((name) => /pls_fy.*outlet.*\.csv/i.test(name))

	// Fallback: if IMLS renames the file, grab any CSV that is NOT the ae file.
	if (!csvName) {
		csvName = entries.find((name) => /\.csv$/i.test(name) && !/system|state|_ae\b|_se\b/i.test(name))
	}

	if (!csvName) {
		process.stderr.write("  Available files in ZIP:\n")

		for (const name of entries) process.stderr.write(`    ${name}\n`)
		process.stderr.write("  ✗ Could not identify outlet CSV — inspect above listing and update script\n")
		process.exitCode = 1

		return
	}

	process.stderr.write(`  Extracting outlet CSV: ${csvName}\n`)
	await $`unzip -o -j ${zipDest} ${csvName} -d ${destDir}`

	const csvDest = join(destDir, basename(csvName))
	const csvSize = statSync(csvDest).size
	const csvSha = await sha256OfFile(csvDest)

	// ------------------------------------------------------------------
	// Remove ZIP (small, but keep destDir clean)
	// ------------------------------------------------------------------
	await rm(zipDest, { force: true })
	process.stderr.write("  Removed ZIP (CSV kept)\n")

	// ------------------------------------------------------------------
	// Write MANIFEST
	// ------------------------------------------------------------------
	const manifest: SourceManifest = {
		source_url: ZIP_URL,
		downloaded_at: new Date().toISOString(),
		filename: basename(csvName),
		sha256: csvSha,
		bytes: csvSize,
	}
	await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n")

	process.stderr.write(`  ✓ ${(csvSize / 1024 / 1024).toFixed(1)} MB  sha256=${csvSha}\n`)
	process.stderr.write(`  MANIFEST written to ${manifestPath}\n`)
}

main().catch((err: Error) => {
	process.stderr.write(`fatal: ${err.message}\n${err.stack}\n`)
	process.exitCode = 1
})
