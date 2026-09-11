/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Re-fetch the IMLS Public Libraries Survey (PLS) outlet-level data. Each US public library branch
 *   (outlet) is one row, ~17K rows with address fields. Source for the `usgov-imls-pls` adapter. US
 *   Public Domain (federal statistical survey).
 *
 *   The FY 2023 release is the most current as of 2026-05. IMLS ships a single ZIP containing CSV,
 *   SAS, and SPSS variants. We extract the outlet-level CSV (pls_fy*_outlet*.csv or similar) and
 *   discard the rest. The administrative-entity (system-level) CSV is intentionally skipped — it has
 *   no per-branch address detail.
 *
 *   Uses Node's built-in fetch (gzip/brotli) and streaming sha256 instead of curl + sha256sum. The
 *   ZIP is unpacked with the `unzip` binary via `node:child_process` (no clean Node equivalent for
 *   member listing + selective extraction).
 *
 *   Invoke via `mailwoman corpus fetch imls-pls --out-root <path>`. Idempotent: if dest CSV exists
 *   and sha matches MANIFEST, skips download.
 */

/* oxlint-disable sister-software/prefer-region-over-marks -- these markers label steps inside one
   procedure, not sections of declarations. A region there folds nothing a reader wants folded. */

import { BYTES_PER_KIB, ByteFormatter } from "@mailwoman/core/fs/formatters"
import { statPath, pathExists } from "@mailwoman/core/fs/readers"
import { makeDirectories, removePathIfPresent } from "@mailwoman/core/fs/writers"
import { extractZipEntry, listZipEntries } from "@mailwoman/core/fs/zip"
import { sha256File } from "@mailwoman/core/hash"
import { basename, join } from "path-ts"

import type { BaseFetchOptions, FetchSummary, SourceManifest } from "#tools/fetch/download"
import { downloadToFile, readManifest, writeManifest } from "#tools/fetch/download"

/**
 * Bytes per KiB — the divisor for human-readable sizes, and the floor below which a "download" is an error page rather
 * than data.
 */

/**
 * The PLS FY 2023 bulk CSV ZIP (most recent as of 2026-05). If IMLS publishes a newer year, update this URL.
 */
const ZIP_URL = "https://www.imls.gov/sites/default/files/2025-08/pls_fy2023_csv.zip"
const SLUG = "usgov-imls-pls"

export type FetchIMLSPLSOptions = BaseFetchOptions

export async function fetchIMLSPLS(
	options: FetchIMLSPLSOptions,
	report?: (line: string) => void
): Promise<FetchSummary> {
	const destDir = join(options.outRoot, SLUG)
	await makeDirectories(destDir)

	const zipDest = join(destDir, basename(ZIP_URL))
	const manifestPath = join(destDir, "MANIFEST.json")

	report?.(`=== ${SLUG}`)

	// MARK: Idempotency check

	const recorded = await readManifest<Partial<SourceManifest>>(manifestPath)

	if (recorded?.sha256 && recorded.filename) {
		const recordedPath = join(destDir, recorded.filename)

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

	// Discover the outlet-level CSV inside the ZIP.
	// Outlet files match: pls_fy*outlet*.csv (case-insensitive)
	// Administrative-entity files match: pls_fy*ae*.csv — we skip those.
	report?.("  Inspecting ZIP contents ...")
	const entries = (await listZipEntries(zipDest)).map((entry) => entry.name)

	let csvName = entries.find((name) => /pls_fy.*outlet.*\.csv/i.test(name))

	// Fallback: if IMLS renames the file, grab any CSV that is NOT the ae file.
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

	const csvDest = join(destDir, basename(csvName))

	await extractZipEntry(zipDest, csvName, csvDest)
	const csvSize = (await statPath(csvDest)).size
	const csvSha = await sha256File(csvDest)

	// MARK: Remove ZIP (small, but keep destDir clean)

	await removePathIfPresent(zipDest)
	report?.("  Removed ZIP (CSV kept)")

	// MARK: Write MANIFEST

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
