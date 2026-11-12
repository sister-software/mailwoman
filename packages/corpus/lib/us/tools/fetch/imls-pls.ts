// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * Re-fetch the IMLS Public Libraries Survey outlet-level data — one row per US
 * public library branch — for the `usgov-imls-pls` adapter.
 *
 * The source is US Public Domain (a federal statistical survey).
 * Extracts the outlet-level CSV from IMLS's single ZIP and discards the rest.
 *
 * The system-level CSV is skipped for having no per-branch address detail.
 */

/* oxlint-disable sister-software/prefer-region-over-marks -- these markers label steps inside one
   procedure rather than sections of declarations. A region there folds no element a reader wants folded. */

import { BYTES_PER_KIB, ByteFormatter } from "@mailwoman/core/fs/formatters"
import { statPath } from "@mailwoman/core/fs/readers/stat"
import { removePathIfPresent } from "@mailwoman/core/fs/writers"
import { extractZipEntry, listZipEntries } from "@mailwoman/core/fs/zip"
import { sha256File } from "@mailwoman/core/hash"
import { basename, type PathBuilder } from "path-ts"

import type { FetchSummary, SourceManifest } from "#tools/fetch/download"
import { downloadToFile, writeManifest } from "#tools/fetch/download"
import { fetchSnapshot, type SnapshotFetchOptions } from "#tools/fetch/storage"

/**
 * The PLS FY 2023 bulk CSV ZIP.
 * Update this URL if IMLS publishes a newer year.
 */
const ZIP_URL = "https://www.imls.gov/sites/default/files/2025-08/pls_fy2023_csv.zip"
const SLUG = "usgov-imls-pls"

export type FetchIMLSPLSOptions = SnapshotFetchOptions

/**
 * The survey year a PLS archive link names, as the vintage `fy23` the survey's own file names use.
 *
 * @throws When the link identifies no `pls_fy<year>` archive.
 */
export function imlsPLSVintage(url: string): string {
	const year = /pls_fy(\d{4})_/u.exec(url)?.[1]

	if (!year) throw new Error(`${SLUG}: ${url} names no pls_fy<year> archive, so its survey year is unknown`)

	return `fy${year.slice(2)}`
}

/**
 * Downloads the pinned survey year into its snapshot, `usgov-imls-pls/<fy..>/`.
 *
 * The vintage comes from the pinned link, so it is known before the download.
 */
export async function fetchIMLSPLS(
	options: FetchIMLSPLSOptions,
	report?: (line: string) => void
): Promise<FetchSummary> {
	report?.(`=== ${SLUG}`)

	return fetchSnapshot(
		options.snapshots,
		SLUG,
		imlsPLSVintage(ZIP_URL),
		(destDir) => downloadIMLSPLS(destDir, report),
		report
	)
}

async function downloadIMLSPLS(destDir: PathBuilder, report?: (line: string) => void): Promise<FetchSummary> {
	const zipDest = destDir(basename(ZIP_URL))
	const manifestPath = destDir("MANIFEST.json")

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
