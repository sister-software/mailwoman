/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Re-fetch the Hawaii State DOE school directory and convert the XLSX workbook to a flat CSV the
 *   `state-hi-schools` adapter can consume.
 *
 *   Upstream is a single XLSX (~64 KB) with two sheets — `HIDOE` (~258 district schools) and `PCS`
 *   (~38 public charter schools). Both sheets share the same header. This module concatenates them
 *   under one shared header so the adapter can stream a single CSV.
 *
 *   License: Hawaii state government open data (Tier A — state PD-equivalent).
 *
 *   Built-in `fetch` (gzip/brotli) replaces curl for the download; the XLSX → CSV step still rides
 *   `python3` + `openpyxl` via `node:child_process` — there is no clean node equivalent without
 *   adding a workbook-parsing dependency.
 *
 *   Invoke via `mailwoman corpus fetch state-hi-schools --out-root <path>`. Idempotent: if the dest
 *   CSV exists and sha matches MANIFEST, skips download.
 */

import { spawn, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, statSync } from "node:fs"
import { unlink } from "node:fs/promises"
import { join } from "node:path"

import { sha256File } from "@mailwoman/core/utils"

import type { BaseFetchOptions, FetchSummary } from "./download.ts"
import { downloadToFile, readManifest, writeManifest } from "./download.ts"

const SOURCE_URL = "https://www.hawaiipublicschools.org/DOE%20Forms/SchoolList.xlsx"
const SLUG = "state-hi-schools"
const CSV_FILENAME = "HI_Public_Schools_List.csv"
const XLSX_FILENAME = "HI_Public_Schools_List.xlsx"

export type FetchStateHISchoolsOptions = BaseFetchOptions

/**
 * The XLSX → CSV converter: concatenate every sheet under one shared header (the first sheet's). Runs as `python3 -c
 * <script> <xlsx-path> <csv-path>`, so `sys.argv[1]`/`sys.argv[2]` are the I/O paths. TODO: Get rid of this.
 */
const PY_CONVERT = `
import csv
import sys
from openpyxl import load_workbook

xlsx_path, csv_path = sys.argv[1], sys.argv[2]
wb = load_workbook(xlsx_path, data_only=True, read_only=True)

with open(csv_path, "w", newline="", encoding="utf-8") as out:
    writer = csv.writer(out)
    shared_header = None
    total_data_rows = 0
    for sheet_name in wb.sheetnames:
        ws = wb[sheet_name]
        rows = ws.iter_rows(values_only=True)
        try:
            header = next(rows)
        except StopIteration:
            continue
        norm_header = ["" if v is None else str(v).strip() for v in header]
        if shared_header is None:
            shared_header = norm_header
            writer.writerow(shared_header)
        elif norm_header != shared_header:
            print(
                f"  ! sheet '{sheet_name}' header diverges from shared header; concatenating anyway",
                file=sys.stderr,
            )
        for row in rows:
            if row is None:
                continue
            # Skip fully-empty rows (XLSX iter_rows can yield phantom trailing rows).
            if all(v is None or (isinstance(v, str) and not v.strip()) for v in row):
                continue
            writer.writerow(["" if v is None else str(v).strip() for v in row])
            total_data_rows += 1

print(f"  converted {total_data_rows} data rows from {len(wb.sheetnames)} sheets", file=sys.stderr)
`

interface Manifest {
	source_url: string
	downloaded_at: string
	filename: string
	sha256: string
	bytes: number
	notes: string
}

/** Mimic `numfmt --to=iec` for a friendly byte-size log line. */
function iec(bytes: number): string {
	if (bytes < 1024) return String(bytes)
	const units = ["K", "M", "G", "T", "P"]
	let value = bytes / 1024
	let i = 0

	while (value >= 1024 && i < units.length - 1) {
		value /= 1024
		i++
	}

	const rounded = value < 10 ? value.toFixed(1) : Math.round(value).toString()

	return `${rounded}${units[i] ?? ""}`
}

/**
 * Run the openpyxl converter. Its stderr narration streams straight through to the process stderr (matching the old
 * `stdio: inherit` behavior) rather than routing through `report` — the python child owns those lines.
 */
async function convertXLSXToCSV(xlsxPath: string, csvPath: string): Promise<void> {
	const child = spawn("python3", ["-c", PY_CONVERT, xlsxPath, csvPath], {
		stdio: ["ignore", "inherit", "inherit"],
	})
	await new Promise<void>((resolve, reject) => {
		child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`python3 converter exited with ${code}`))))
		child.on("error", reject)
	})
}

export async function fetchStateHISchools(
	options: FetchStateHISchoolsOptions,
	report?: (line: string) => void
): Promise<FetchSummary> {
	const destDir = join(options.outRoot, SLUG)
	mkdirSync(destDir, { recursive: true })

	const xlsxDest = join(destDir, XLSX_FILENAME)
	const csvDest = join(destDir, CSV_FILENAME)
	const manifestPath = join(destDir, "MANIFEST.json")

	report?.(`=== ${SLUG}`)

	// Idempotency: skip if CSV exists and sha matches recorded MANIFEST.
	if (existsSync(csvDest)) {
		const recorded = await readManifest<Partial<Manifest>>(manifestPath)

		if (recorded?.sha256 && recorded.filename === CSV_FILENAME) {
			const actualSha = await sha256File(csvDest)

			if (actualSha === recorded.sha256) {
				report?.(`  ✓ Already current (sha256 matches MANIFEST) — skipping download.`)

				return { fetched: 0, skipped: 1, failed: 0, failedCodes: [] }
			}
		}
	}

	// Preflight: openpyxl must be importable.
	const preflight = spawnSync("python3", ["-c", "import openpyxl"], { stdio: "ignore" })

	if (preflight.status !== 0) {
		report?.(
			`  ✗ python3 with the \`openpyxl\` package is required to convert the HIDOE XLSX.\n` +
				`    Debian/Ubuntu:  sudo apt-get install -y python3-openpyxl\n` +
				`    macOS Homebrew: brew install python && pip3 install openpyxl`
		)

		return { fetched: 0, skipped: 0, failed: 1, failedCodes: [SLUG] }
	}

	// Download XLSX.
	report?.(`  Downloading ${SOURCE_URL} ...`)

	try {
		await downloadToFile({
			url: SOURCE_URL,
			dest: xlsxDest,
			timeoutMs: 600_000,
			headers: { "Accept-Encoding": "gzip, br" },
			report,
		})
	} catch (err) {
		report?.(`  ✗ Download failed (${(err as Error).message})`)

		return { fetched: 0, skipped: 0, failed: 1, failedCodes: [SLUG] }
	}

	const xlsxSize = statSync(xlsxDest).size
	report?.(`  Downloaded XLSX: ${iec(xlsxSize)}`)

	if (xlsxSize < 1024) {
		report?.(`  ✗ Response too small (${xlsxSize} bytes) — probable error page`)

		return { fetched: 0, skipped: 0, failed: 1, failedCodes: [SLUG] }
	}

	// Convert XLSX → CSV (concatenate both sheets under one shared header).
	report?.(`  Converting XLSX → CSV (concatenating sheets) ...`)
	await convertXLSXToCSV(xlsxDest, csvDest)

	const csvSize = statSync(csvDest).size
	const csvSha = await sha256File(csvDest)

	// Remove XLSX (CSV is the canonical artifact the adapter consumes).
	await unlink(xlsxDest)
	report?.(`  Removed XLSX (CSV kept)`)

	// Write MANIFEST.
	const manifest: Manifest = {
		source_url: SOURCE_URL,
		downloaded_at: new Date().toISOString(),
		filename: CSV_FILENAME,
		sha256: csvSha,
		bytes: csvSize,
		notes: "Converted from XLSX (sheets HIDOE + PCS concatenated under shared header).",
	}
	await writeManifest(manifestPath, manifest)

	report?.(`  ✓ ${iec(csvSize)}  sha256=${csvSha}`)
	report?.(`  MANIFEST written to ${manifestPath}`)

	return { fetched: 1, skipped: 0, failed: 0, failedCodes: [] }
}
