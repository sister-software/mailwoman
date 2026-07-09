/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Re-fetch the NPPES (National Plan and Provider Enumeration System) full monthly data
 *   dissemination file. ~7M provider rows with venue+address data. Source for the `usgov-nppes`
 *   adapter. US Public Domain.
 *
 *   The file is published monthly by CMS. This module discovers the current filename by scraping the
 *   NPI_Files.html index, then downloads the ZIP and extracts only the main registry CSV
 *   (npidata_pfile_*.csv). The smaller endpoint/othername/pl files stay zipped — we don't need them.
 *
 *   Uses Node's built-in fetch (gzip/brotli) to parse the HTML index and download the ZIP, and
 *   streaming sha256 instead of sha256sum. The ZIP is unpacked with the `unzip` binary via
 *   `node:child_process` (no clean Node equivalent for member listing + selective extraction). NOTE:
 *   the old bash fetcher used `curl --continue-at -` to resume a partial download; native fetch has
 *   no resume, so a partial run re-downloads from the start.
 *
 *   Invoke via `mailwoman corpus fetch nppes --out-root <path>`. Idempotent: if dest CSV exists and
 *   sha256 matches MANIFEST, skips download.
 */

import { execFile } from "node:child_process"
import { existsSync, mkdirSync, statSync } from "node:fs"
import { rm } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"

import { sha256File } from "@mailwoman/core/utils"

import type { BaseFetchOptions, FetchSummary } from "./download.ts"
import { downloadToFile, readManifest, writeManifest } from "./download.ts"

const execFileAsync = promisify(execFile)

const INDEX_URL = "https://download.cms.gov/nppes/NPI_Files.html"
const BASE_URL = "https://download.cms.gov/nppes"
const SLUG = "usgov-nppes"

export type FetchNPPESOptions = BaseFetchOptions

interface SourceManifest {
	source_url: string
	downloaded_at: string
	filename: string
	sha256: string
	bytes: number
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
async function findNpidataCSV(zipPath: string): Promise<string | undefined> {
	const listing = await execFileAsync("unzip", ["-l", zipPath])

	for (const line of listing.stdout.split("\n")) {
		const match = /npidata_pfile\S+\.csv/i.exec(line)

		if (match?.[0]) return match[0]
	}

	return undefined
}

export async function fetchNPPES(options: FetchNPPESOptions, report?: (line: string) => void): Promise<FetchSummary> {
	const destDir = join(options.outRoot, SLUG)
	mkdirSync(destDir, { recursive: true })
	const manifestPath = join(destDir, "MANIFEST.json")

	report?.(`=== ${SLUG}`)
	report?.(`  Discovering latest full-replacement ZIP from ${INDEX_URL} ...`)

	const zipFilename = await discoverLatestZip()

	if (!zipFilename) {
		report?.(`  ✗ Could not discover ZIP filename from ${INDEX_URL}`)

		return { fetched: 0, skipped: 0, failed: 1, failedCodes: [SLUG] }
	}

	const zipURL = `${BASE_URL}/${zipFilename}`
	const zipDest = join(destDir, zipFilename)
	report?.(`  Latest full file: ${zipFilename}`)

	// ------------------------------------------------------------------
	// Idempotency check: if the main CSV already exists and sha matches,
	// skip re-download.
	// ------------------------------------------------------------------
	const recorded = await readManifest<Partial<SourceManifest>>(manifestPath)

	if (recorded?.sha256 && recorded.filename) {
		const recordedPath = join(destDir, recorded.filename)

		if (existsSync(recordedPath) && (await sha256File(recordedPath)) === recorded.sha256) {
			report?.("  ✓ Already current (sha256 matches MANIFEST) — skipping download.")

			return { fetched: 0, skipped: 1, failed: 0, failedCodes: [] }
		}
	}

	// ------------------------------------------------------------------
	// Download ZIP (large; 60-minute timeout)
	// ------------------------------------------------------------------
	report?.(`  Downloading ${zipURL} ...`)
	const { bytes: zipSize } = await downloadToFile({
		url: zipURL,
		dest: zipDest,
		timeoutMs: 3_600_000,
		headers: { "Accept-Encoding": "gzip, br" },
		report,
	})
	report?.(`  Downloaded: ${(zipSize / 1024 / 1024).toFixed(1)} MB`)

	// ------------------------------------------------------------------
	// Extract only the main registry CSV (npidata_pfile_*.csv)
	// ------------------------------------------------------------------
	report?.("  Extracting npidata_pfile CSV from ZIP ...")
	const csvName = await findNpidataCSV(zipDest)

	if (!csvName) {
		report?.("  ✗ Could not find npidata_pfile CSV inside ZIP")

		return { fetched: 0, skipped: 0, failed: 1, failedCodes: [SLUG] }
	}

	report?.(`  Extracting: ${csvName}`)
	await execFileAsync("unzip", ["-o", "-j", zipDest, csvName, "-d", destDir])

	const csvDest = join(destDir, csvName)
	const csvSize = statSync(csvDest).size
	const csvSha = await sha256File(csvDest)
	report?.(`  CSV size: ${(csvSize / 1024 / 1024).toFixed(1)} MB`)

	// ------------------------------------------------------------------
	// Remove the ZIP to reclaim ~1 GB (the CSV is what adapters consume)
	// ------------------------------------------------------------------
	await rm(zipDest, { force: true })
	report?.("  Removed ZIP (CSV kept)")

	// ------------------------------------------------------------------
	// Write MANIFEST (records the extracted CSV, not the ZIP)
	// ------------------------------------------------------------------
	const manifest: SourceManifest = {
		source_url: zipURL,
		downloaded_at: new Date().toISOString(),
		filename: csvName,
		sha256: csvSha,
		bytes: csvSize,
	}
	await writeManifest(manifestPath, manifest)

	report?.(`  ✓ ${(csvSize / 1024 / 1024).toFixed(1)} MB  sha256=${csvSha}`)
	report?.(`  MANIFEST written to ${manifestPath}`)

	return { fetched: 1, skipped: 0, failed: 0, failedCodes: [] }
}
