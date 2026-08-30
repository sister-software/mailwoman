/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Re-fetch the Hawaii State DOE school directory as its original XLSX workbook. The
 *   `state-hi-schools` adapter reads both worksheets directly.
 *
 *   Upstream is a single XLSX (~64 KB) with two sheets — `HIDOE` (~258 district schools) and `PCS`
 *   (~38 public charter schools). Both sheets are validated against the adapter's required columns
 *   before the workbook is recorded as fetched.
 *
 *   License: Hawaii state government open data (Tier A — state PD-equivalent).
 *
 *   Invoke via `mailwoman corpus fetch state-hi-schools --out-root <path>`. Idempotent: if the dest
 *   workbook exists and its sha matches MANIFEST, skips download.
 */

import { BYTES_PER_KIB, ByteFormatter } from "@mailwoman/core/fs/formatters"
import { statPath, pathExists } from "@mailwoman/core/fs/readers"
import { makeDirectories, removePathIfPresent } from "@mailwoman/core/fs/writers"
import { sha256File } from "@mailwoman/core/utils"
import { join } from "@mailwoman/platform/path"
import { XLSXSpliterator, type XLSXCellValue } from "spliterator"

import { STATE_HI_SCHOOL_REQUIRED_COLUMNS, STATE_HI_SCHOOL_SHEETS } from "#adapters/state-hi-schools/workbook"

import type { BaseFetchOptions, FetchSummary } from "./download.ts"
import { downloadToFile, readManifest, writeManifest } from "./download.ts"

const SOURCE_URL = "https://www.hawaiipublicschools.org/DOE%20Forms/SchoolList.xlsx"
const SLUG = "state-hi-schools"
const XLSX_FILENAME = "HI_Public_Schools_List.xlsx"

export interface FetchStateHISchoolsOptions extends BaseFetchOptions {
	/**
	 * Workbook URL. Defaults to the Hawaii DOE source; overridable for an isolated fetch test.
	 */
	sourceURL?: string
}

interface Manifest {
	source_url: string
	downloaded_at: string
	filename: string
	sha256: string
	bytes: number
	notes: string
}

async function validateWorkbook(path: string): Promise<void> {
	for (const sheet of STATE_HI_SCHOOL_SHEETS) {
		const rows = await XLSXSpliterator.fromAsync<XLSXCellValue[]>(path, {
			sheet,
			header: false,
			take: 2,
		}).toArray()

		const header = rows[0]

		if (!header || rows.length < 2) {
			throw new Error(`sheet ${sheet} must contain a header and at least one school row`)
		}

		// Exact casing is part of the adapter contract: object mode preserves the workbook's header names, so accepting
		// `Code` here while the reader asks for `record.code` would validate a workbook whose every row is later skipped.
		const columns = new Set(header.map((cell) => String(cell ?? "").trim()))

		const missing = STATE_HI_SCHOOL_REQUIRED_COLUMNS.filter((column) => !columns.has(column))

		if (missing.length) {
			throw new Error(`sheet ${sheet} is missing required columns: ${missing.join(", ")}`)
		}
	}
}

export async function fetchStateHISchools(
	options: FetchStateHISchoolsOptions,
	report?: (line: string) => void
): Promise<FetchSummary> {
	const destDir = join(options.outRoot, SLUG)
	await makeDirectories(destDir)

	const xlsxDest = join(destDir, XLSX_FILENAME)
	const manifestPath = join(destDir, "MANIFEST.json")
	const sourceURL = options.sourceURL ?? SOURCE_URL

	report?.(`=== ${SLUG}`)

	// Idempotency: skip if the source workbook exists and sha matches the recorded manifest.
	if (await pathExists(xlsxDest)) {
		const recorded = await readManifest<Partial<Manifest>>(manifestPath)

		if (recorded?.sha256 && recorded.filename === XLSX_FILENAME) {
			const actualSha = await sha256File(xlsxDest)

			if (actualSha === recorded.sha256) {
				report?.(`  ✓ Already current (sha256 matches MANIFEST) — skipping download.`)

				return { fetched: 0, skipped: 1, failed: 0, failedCodes: [] }
			}
		}
	}

	// Download XLSX.
	report?.(`  Downloading ${sourceURL} ...`)

	try {
		await downloadToFile({
			url: sourceURL,
			dest: xlsxDest,
			timeoutMs: 600_000,
			headers: { "Accept-Encoding": "gzip, br" },
			report,
		})
	} catch (error) {
		report?.(`  ✗ Download failed (${(error as Error).message})`)

		return { fetched: 0, skipped: 0, failed: 1, failedCodes: [SLUG] }
	}

	const xlsxSize = (await statPath(xlsxDest)).size
	report?.(`  Downloaded XLSX: ${ByteFormatter.formatIEC(xlsxSize)}`)

	if (xlsxSize < BYTES_PER_KIB) {
		report?.(`  ✗ Response too small (${xlsxSize} bytes) — probable error page`)
		await removePathIfPresent(xlsxDest)

		return { fetched: 0, skipped: 0, failed: 1, failedCodes: [SLUG] }
	}

	try {
		await validateWorkbook(xlsxDest)
	} catch (error) {
		report?.(`  ✗ Workbook validation failed (${(error as Error).message})`)
		await removePathIfPresent(xlsxDest)

		return { fetched: 0, skipped: 0, failed: 1, failedCodes: [SLUG] }
	}

	const xlsxSha = await sha256File(xlsxDest)

	// Write MANIFEST.
	const manifest: Manifest = {
		source_url: sourceURL,
		downloaded_at: new Date().toISOString(),
		filename: XLSX_FILENAME,
		sha256: xlsxSha,
		bytes: xlsxSize,
		notes: "Original XLSX; the adapter reads the HIDOE and PCS sheets directly.",
	}

	await writeManifest(manifestPath, manifest)

	report?.(
		`  ✓ ${STATE_HI_SCHOOL_SHEETS.join(" + ")} validated · ${ByteFormatter.formatIEC(xlsxSize)}  sha256=${xlsxSha}`
	)

	report?.(`  MANIFEST written to ${manifestPath}`)

	return { fetched: 1, skipped: 0, failed: 0, failedCodes: [] }
}
