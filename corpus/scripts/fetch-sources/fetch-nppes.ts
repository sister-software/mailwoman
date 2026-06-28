#!/usr/bin/env npx tsx
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Re-fetch the NPPES (National Plan and Provider Enumeration System) full monthly data
 *   dissemination file. ~7M provider rows with venue+address data. Source for the planned
 *   `usgov-nppes` adapter. US Public Domain.
 *
 *   The file is published monthly by CMS. This script discovers the current filename by scraping the
 *   NPI_Files.html index, then downloads the ZIP and extracts only the main registry CSV
 *   (npidata_pfile_*.csv). The smaller endpoint/othername/pl files stay zipped — we don't need them.
 *
 *   Replaces the bash `fetch-sources/fetch-nppes.sh` with a TypeScript pipeline matching the style of
 *   the other corpus scripts (fetch-nad, ingest-csv): Node's built-in fetch (gzip/brotli) parses the
 *   HTML index and downloads the ZIP, and `node:crypto` sha256 replaces sha256sum. The ZIP is
 *   unpacked with `unzip` via zx (no clean Node equivalent for member listing + selective
 *   extraction). NOTE: the bash version used `curl --continue-at -` to resume a partial download;
 *   native fetch has no resume, so a partial run re-downloads from the start.
 *
 *   ## Usage
 *
 *   ```sh
 *   OUT_ROOT=/mnt/playpen/mailwoman-data/corpus/sources \
 *     npx tsx packages/corpus/scripts/fetch-sources/fetch-nppes.ts
 *   ```
 *
 *   Defaults to writing under `./data/corpus/sources/` in the repo root. Idempotent: if dest CSV
 *   exists and sha256 matches MANIFEST, skips download.
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
import { join } from "node:path"
import { parseArgs } from "node:util"

import { $ } from "zx"

const INDEX_URL = "https://download.cms.gov/nppes/NPI_Files.html"
const BASE_URL = "https://download.cms.gov/nppes"
const SLUG = "usgov-nppes"

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

/**
 * Scrape the NPI_Files.html index for the latest full monthly ZIP. Full-replacement files match
 * `NPPES_Data_Dissemination_<Month>_<Year>*.zip`; weekly files carry a `MMDDYY_MMDDYY` date range, which we exclude.
 */
async function discoverLatestZip(): Promise<string | undefined> {
	const res = await fetch(INDEX_URL, {
		headers: { "Accept-Encoding": "gzip, br" },
		signal: AbortSignal.timeout(60_000),
	})

	if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} on ${INDEX_URL}`)
	const html = await res.text()

	for (const match of html.matchAll(/NPPES_Data_Dissemination_[A-Za-z]+_\d{4}[^"]*\.zip/g)) {
		const name = match[0]

		if (name && !/\d{6}_\d{6}/.test(name)) return name
	}

	return undefined
}

/** Extract the main registry CSV name (npidata_pfile_*.csv) from a ZIP's `unzip -l` listing. */
async function findNpidataCsv(zipPath: string): Promise<string | undefined> {
	const listing = await $`unzip -l ${zipPath}`

	for (const line of listing.stdout.split("\n")) {
		const match = /npidata_pfile\S+\.csv/i.exec(line)

		if (match?.[0]) return match[0]
	}

	return undefined
}

function parseCliArgs() {
	const { values } = parseArgs({
		options: {
			"out-root": { type: "string", default: process.env.OUT_ROOT },
		},
	})

	return {
		outRoot: values["out-root"] ?? repoRootDataSources(),
	}
}

async function main(): Promise<void> {
	$.verbose = false

	const { outRoot } = parseCliArgs()
	const destDir = join(outRoot, SLUG)
	mkdirSync(destDir, { recursive: true })
	const manifestPath = join(destDir, "MANIFEST.json")

	process.stderr.write(`=== ${SLUG}\n`)
	process.stderr.write(`  Discovering latest full-replacement ZIP from ${INDEX_URL} ...\n`)

	const zipFilename = await discoverLatestZip()

	if (!zipFilename) {
		process.stderr.write(`  ✗ Could not discover ZIP filename from ${INDEX_URL}\n`)
		process.exitCode = 1

		return
	}

	const zipUrl = `${BASE_URL}/${zipFilename}`
	const zipDest = join(destDir, zipFilename)
	process.stderr.write(`  Latest full file: ${zipFilename}\n`)

	// ------------------------------------------------------------------
	// Idempotency check: if the main CSV already exists and sha matches,
	// skip re-download.
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
	// Download ZIP (large; 60-minute timeout)
	// ------------------------------------------------------------------
	process.stderr.write(`  Downloading ${zipUrl} ...\n`)
	const zipSize = await downloadToFile(zipUrl, zipDest, 3_600_000)
	process.stderr.write(`  Downloaded: ${(zipSize / 1024 / 1024).toFixed(1)} MB\n`)

	// ------------------------------------------------------------------
	// Extract only the main registry CSV (npidata_pfile_*.csv)
	// ------------------------------------------------------------------
	process.stderr.write("  Extracting npidata_pfile CSV from ZIP ...\n")
	const csvName = await findNpidataCsv(zipDest)

	if (!csvName) {
		process.stderr.write("  ✗ Could not find npidata_pfile CSV inside ZIP\n")
		process.exitCode = 1

		return
	}

	process.stderr.write(`  Extracting: ${csvName}\n`)
	await $`unzip -o -j ${zipDest} ${csvName} -d ${destDir}`

	const csvDest = join(destDir, csvName)
	const csvSize = statSync(csvDest).size
	const csvSha = await sha256OfFile(csvDest)
	process.stderr.write(`  CSV size: ${(csvSize / 1024 / 1024).toFixed(1)} MB\n`)

	// ------------------------------------------------------------------
	// Remove the ZIP to reclaim ~1 GB (the CSV is what adapters consume)
	// ------------------------------------------------------------------
	await rm(zipDest, { force: true })
	process.stderr.write("  Removed ZIP (CSV kept)\n")

	// ------------------------------------------------------------------
	// Write MANIFEST (records the extracted CSV, not the ZIP)
	// ------------------------------------------------------------------
	const manifest: SourceManifest = {
		source_url: zipUrl,
		downloaded_at: new Date().toISOString(),
		filename: csvName,
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
