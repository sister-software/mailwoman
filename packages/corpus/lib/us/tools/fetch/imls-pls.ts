/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Re-fetch the IMLS Public Libraries Survey outlet-level data — one row per US public library branch —
 * for the `usgov-imls-pls` adapter; the source is US Public Domain (a federal statistical survey).
 * Extracts the outlet-level CSV from IMLS's single ZIP and discards the rest; the system-level CSV is
 * skipped for having no per-branch address detail.
 */

/* oxlint-disable sister-software/prefer-region-over-marks -- these markers label steps inside one
   procedure rather than sections of declarations. A region there folds no element a reader wants folded. */

import { BYTES_PER_KIB, ByteFormatter } from "@mailwoman/core/fs/formatters"
import { statPath, pathExists } from "@mailwoman/core/fs/readers"
import { makeDirectories, removePathIfPresent } from "@mailwoman/core/fs/writers"
import { extractZipEntry, listZipEntries } from "@mailwoman/core/fs/zip"
import { sha256File } from "@mailwoman/core/hash"
import { basename } from "path-ts"

import type { BaseFetchOptions, FetchSummary, SourceManifest } from "#tools/fetch/download/index"
import { downloadToFile, readManifest, writeManifest } from "#tools/fetch/download/index"

/**
 * The PLS FY 2023 bulk CSV ZIP; update this URL if IMLS publishes a newer year.
 */
const ZIP_URL = "https://www.imls.gov/sites/default/files/2025-08/pls_fy2023_csv.zip"
const SLUG = "usgov-imls-pls"

export type FetchIMLSPLSOptions = BaseFetchOptions

export async function fetchIMLSPLS(
	options: FetchIMLSPLSOptions,
	report?: (line: string) => void
): Promise<FetchSummary> {
	const destDir = options.outRoot(SLUG)
	await makeDirectories(destDir)

	const zipDest = destDir(basename(ZIP_URL))
	const manifestPath = destDir("MANIFEST.json")

	report?.(`=== ${SLUG}`)

	// MARK: Idempotency check

	const recorded = await readManifest<Partial<SourceManifest>>(manifestPath)

	if (recorded?.sha256 && recorded.filename) {
		const recordedPath = destDir(recorded.filename)

		if ((await pathExists(recordedPath)) && (await sha256File(recordedPath)) === recorded.sha256) {
			report?.("  ✓ Already current (sha256 matches MANIFEST) — skipping download.")

			return { fetched: 0, skipped: 1, failed: 0, failedCodes: [] }
		}
	}

	// MARK: Download ZIP

	report?.(`  Downloading ${ZIP_URL} ...`)

	const { bytes: zipSize } = await downloadToFile({
		url: ZIP_URL,
		dest: zipDest,
		timeoutMs: 600_000,
		headers: { "Accept-Encoding": "gzip, br" },
		report,
	})

	report?.(`  Downloaded: ${ByteFormatter.formatIEC(zipSize)}`)

	if (zipSize < BYTES_PER_KIB) {
		report?.(`  ✗ Response too small (${zipSize} bytes) — probable error page`)

		return { fetched: 0, skipped: 0, failed: 1, failedCodes: [SLUG] }
	}

	// Outlet files match `pls_fy*outlet*.csv`; administrative-entity files are skipped.
	report?.("  Inspecting ZIP contents ...")
	const entries = (await listZipEntries(zipDest)).map((entry) => entry.name)

	let csvName = entries.find((name) => /pls_fy.*outlet.*\.csv/i.test(name))

	if (!csvName) {
		csvName = entries.find((name) => /\.csv$/i.test(name) && !/system|state|_ae\b|_se\b/i.test(name))
	}

	if (!csvName) {
		report?.("  Available files in ZIP:")

		for (const name of entries) {
			report?.(`    ${name}`)
		}

		report?.("  ✗ Could not identify outlet CSV — inspect above listing and update this module")

		return { fetched: 0, skipped: 0, failed: 1, failedCodes: [SLUG] }
	}

	report?.(`  Extracting outlet CSV: ${csvName}`)

	const csvDest = destDir(basename(csvName))

	await extractZipEntry(zipDest, csvName, csvDest)
	const csvSize = (await statPath(csvDest)).size
	const csvSha = await sha256File(csvDest)

	// MARK: Remove ZIP (small, but keep destDir clean)

	await removePathIfPresent(zipDest)
	report?.("  Removed ZIP (CSV kept)")

	// MARK: Write manifest

	const manifest: SourceManifest = {
		source_url: ZIP_URL,
		downloaded_at: new Date().toISOString(),
		filename: basename(csvName),
		sha256: csvSha,
		bytes: csvSize,
	}

	await writeManifest(manifestPath, manifest)

	report?.(`  ✓ ${(csvSize / 1024 / 1024).toFixed(1)} MB  sha256=${csvSha}`)
	report?.(`  MANIFEST written to ${manifestPath}`)

	return { fetched: 1, skipped: 0, failed: 0, failedCodes: [] }
}
