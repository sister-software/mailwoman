/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Re-fetch the NPPES (National Plan and Provider Enumeration System) full monthly data dissemination
 * file for the `usgov-nppes` adapter; the source is US Public Domain. Discovers the current filename
 * by scraping the NPI_Files.html index, then extracts only the main registry CSV
 * (`npidata_pfile_*.csv`) and leaves the endpoint/othername/pl files zipped.
 *
 * Native fetch has no resume, so a partial run re-downloads from the start.
 */

/* oxlint-disable sister-software/prefer-region-over-marks -- these markers label steps inside one
   procedure rather than sections of declarations. A region there folds no element a reader wants folded. */

import { APIClient, pluckResponseData } from "@mailwoman/core/api"
import { statPath, pathExists } from "@mailwoman/core/fs/readers"
import { makeDirectories, removePathIfPresent } from "@mailwoman/core/fs/writers"
import { extractZipEntry, listZipEntries } from "@mailwoman/core/fs/zip"
import { sha256File } from "@mailwoman/core/hash"
import { basename, type PathBuilderLike } from "path-ts"

import type { BaseFetchOptions, FetchSummary, SourceManifest } from "#tools/fetch/download/index"
import { downloadToFile, readManifest, writeManifest } from "#tools/fetch/download/index"

const INDEX_URL = "https://download.cms.gov/nppes/NPI_Files.html"
const BASE_URL = "https://download.cms.gov/nppes"
const SLUG = "usgov-nppes"

export type FetchNPPESOptions = BaseFetchOptions

/**
 * Scrape the NPI_Files.html index for the latest full monthly ZIP: full-replacement
 * files match `NPPES_Data_Dissemination_<Month>_<Year>*.zip`, while weekly files
 * carry a `MMDDYY_MMDDYY` date range and are excluded.
 */
async function discoverLatestZip(): Promise<string | undefined> {
	const html = await new APIClient({
		displayName: "nppes-index",
		retry: true,
		axios: { headers: { "Accept-Encoding": "gzip, br" } },
	})
		.fetch<string>({ url: INDEX_URL, responseType: "text", timeout: 60_000 })
		.then(pluckResponseData)

	for (const match of html.matchAll(/NPPES_Data_Dissemination_[A-Za-z]+_\d{4}[^"]*\.zip/g)) {
		const name = match[0]

		if (name && !/\d{6}_\d{6}/.test(name)) return name
	}

	return undefined
}

/**
 * The main registry CSV (`npidata_pfile_*.csv`); the archive also carries a header file
 * and a per-month change file.
 */
async function findNpidataCSV(zipPath: PathBuilderLike): Promise<string | undefined> {
	const entries = await listZipEntries(zipPath)

	return entries.find((entry) => /npidata_pfile\S+\.csv/i.test(entry.name))?.name
}

export async function fetchNPPES(options: FetchNPPESOptions, report?: (line: string) => void): Promise<FetchSummary> {
	const destDir = options.outRoot(SLUG)
	await makeDirectories(destDir)
	const manifestPath = destDir("MANIFEST.json")

	report?.(`=== ${SLUG}`)
	report?.(`  Discovering latest full-replacement ZIP from ${INDEX_URL} ...`)

	const zipFilename = await discoverLatestZip()

	if (!zipFilename) {
		report?.(`  ✗ Could not discover ZIP filename from ${INDEX_URL}`)

		return { fetched: 0, skipped: 0, failed: 1, failedCodes: [SLUG] }
	}

	const zipURL = `${BASE_URL}/${zipFilename}`
	const zipDest = destDir(zipFilename)
	report?.(`  Latest full file: ${zipFilename}`)

	const recorded = await readManifest<Partial<SourceManifest>>(manifestPath)

	if (recorded?.sha256 && recorded.filename) {
		const recordedPath = destDir(recorded.filename)

		if ((await pathExists(recordedPath)) && (await sha256File(recordedPath)) === recorded.sha256) {
			report?.("  ✓ Already current (sha256 matches MANIFEST) — skipping download.")

			return { fetched: 0, skipped: 1, failed: 0, failedCodes: [] }
		}
	}

	// MARK: Download ZIP

	report?.(`  Downloading ${zipURL} ...`)

	const { bytes: zipSize } = await downloadToFile({
		url: zipURL,
		dest: zipDest,
		timeoutMs: 3_600_000,
		headers: { "Accept-Encoding": "gzip, br" },
		report,
	})

	report?.(`  Downloaded: ${(zipSize / 1024 / 1024).toFixed(1)} MB`)

	// MARK: Extract only the main registry CSV (npidata_pfile_*.csv)

	report?.("  Extracting npidata_pfile CSV from ZIP ...")
	const csvName = await findNpidataCSV(zipDest)

	if (!csvName) {
		report?.("  ✗ Could not find npidata_pfile CSV inside ZIP")

		return { fetched: 0, skipped: 0, failed: 1, failedCodes: [SLUG] }
	}

	report?.(`  Extracting: ${csvName}`)

	const csvDest = destDir(basename(csvName))

	await extractZipEntry(zipDest, csvName, csvDest)
	const csvSize = (await statPath(csvDest)).size
	const csvSha = await sha256File(csvDest)
	report?.(`  CSV size: ${(csvSize / 1024 / 1024).toFixed(1)} MB`)

	// MARK: Remove the ZIP

	await removePathIfPresent(zipDest)
	report?.("  Removed ZIP (CSV kept)")

	// MARK: Write manifest for extracted CSV

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
