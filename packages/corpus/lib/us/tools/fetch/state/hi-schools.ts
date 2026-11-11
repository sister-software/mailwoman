/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Re-fetch the Hawaii State DOE school directory as its original xlsx workbook. The
 *   `state-hi-schools` adapter reads both worksheets directly.
 *
 *   Upstream is a single xlsx (~64 KB) with two sheets — `hidoe` (~258 district schools) and `PCS`
 *   (~38 public charter schools). Both sheets are validated against the adapter's required columns
 *   before the workbook is recorded as fetched.
 *
 *   License: Hawaii state government open data (Tier A — state PD-equivalent).
 *
 *   Invoke via `mailwoman corpus fetch state-hi-schools`. A re-run skips the download only when the host
 *   still states the `ETag` (or `Last-Modified`) the manifest recorded and the workbook on disk matches it.
 */

import { BYTES_PER_KIB, ByteFormatter } from "@mailwoman/core/fs/formatters"
import { statPath, pathExists } from "@mailwoman/core/fs/readers/stat"
import { makeDirectories, removePathIfPresent } from "@mailwoman/core/fs/writers"
import { sha256File } from "@mailwoman/core/hash"
import type { PathBuilderLike } from "path-ts"
import { XLSXSpliterator, type XLSXCellValue } from "spliterator"

import type { BaseFetchOptions, FetchSummary, SourceManifest } from "#tools/fetch/download"
import { downloadToFile, readManifest, writeManifest } from "#tools/fetch/download"
import { STATE_HI_SCHOOL_REQUIRED_COLUMNS, STATE_HI_SCHOOL_SHEETS } from "#us/adapters/state/hi-schools/workbook"

const SOURCE_URL = "https://www.hawaiipublicschools.org/DOE%20Forms/SchoolList.xlsx"
const SLUG = "state-hi-schools"
const XLSX_FILENAME = "HI_Public_Schools_List.xlsx"

export interface FetchStateHISchoolsOptions extends BaseFetchOptions {
	/**
	 * Workbook URL.
	 *
	 * Overridable for an isolated fetch test.
	 *
	 * @defaultValue the Hawaii DOE source.
	 */
	sourceURL?: string
}

interface Manifest extends SourceManifest {
	notes: string
}

/**
 * The version the host states for the workbook: its `ETag`, or its `Last-Modified` when it sends no ETag.
 * Measured on 2026-11-10, the DOE's host sends both.
 *
 * @returns `null` when the host states neither or the request fails, so the caller
 * downloads again and the download reports any failure.
 */
async function servedVersion(url: string): Promise<string | null> {
	const res = await fetch(url, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(60_000) }).catch(
		() => null
	)

	if (!res?.ok) return null

	const etag = res.headers.get("etag")
	const lastModified = res.headers.get("last-modified")

	return etag ? `etag ${etag}` : lastModified ? `last-modified ${lastModified}` : null
}

async function validateWorkbook(path: PathBuilderLike): Promise<void> {
	for (const sheet of STATE_HI_SCHOOL_SHEETS) {
		// XLSXSpliterator opens a string, URL, or byte source.
		// A PathBuilder is none of those.
		const rows = await XLSXSpliterator.fromAsync<XLSXCellValue[]>(path.toString(), {
			sheet,
			header: false,
			take: 2,
		}).toArray()

		const header = rows[0]

		if (!header || rows.length < 2) {
			throw new Error(`sheet ${sheet} must contain a header and at least one school row`)
		}

		// Exact casing is part of the adapter interface: object mode preserves the workbook's
		// header names, so accepting `Code` here while the reader asks for `record.code`
		// would validate a workbook whose every row is later skipped.
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
	const destDir = options.outRoot(SLUG)
	await makeDirectories(destDir)

	const xlsxDest = destDir(XLSX_FILENAME)
	const manifestPath = destDir("MANIFEST.json")
	const sourceURL = options.sourceURL ?? SOURCE_URL

	report?.(`=== ${SLUG}`)

	// The workbook is skipped only when the publisher still serves the version the manifest
	// recorded and the file on disk is the one the manifest describes.
	const served = await servedVersion(sourceURL)

	if (served != null && (await pathExists(xlsxDest))) {
		const recorded = await readManifest<Partial<Manifest>>(manifestPath)

		if (
			recorded?.publisher_version === served &&
			recorded.filename === XLSX_FILENAME &&
			recorded.sha256 === (await sha256File(xlsxDest))
		) {
			report?.(`  ✓ Already current (the publisher still serves ${served}) — skipping download.`)

			return { fetched: 0, skipped: 1, failed: 0, failedCodes: [] }
		}
	}

	report?.(`  The publisher serves ${served ?? "no stated version"}`)

	// Download xlsx.
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

	// Write manifest.
	const manifest: Manifest = {
		source_url: sourceURL,
		downloaded_at: new Date().toISOString(),
		filename: XLSX_FILENAME,
		sha256: xlsxSha,
		bytes: xlsxSize,
		...(served != null ? { publisher_version: served } : {}),
		notes: "Original XLSX; the adapter reads the HIDOE and PCS sheets directly.",
	}

	await writeManifest(manifestPath, manifest)

	report?.(
		`  ✓ ${STATE_HI_SCHOOL_SHEETS.join(" + ")} validated · ${ByteFormatter.formatIEC(xlsxSize)}  sha256=${xlsxSha}`
	)

	report?.(`  MANIFEST written to ${manifestPath}`)

	return { fetched: 1, skipped: 0, failed: 0, failedCodes: [] }
}
