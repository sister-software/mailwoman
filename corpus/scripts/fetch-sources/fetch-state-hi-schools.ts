#!/usr/bin/env npx tsx
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Re-fetch the Hawaii State DOE school directory and convert the XLSX workbook to a flat CSV the
 *   `state-hi-schools` adapter can consume.
 *
 *   Upstream is a single XLSX (~64 KB) with two sheets — `HIDOE` (~258 district schools) and `PCS`
 *   (~38 public charter schools). Both sheets share the same header. This script concatenates them
 *   under one shared header so the adapter can stream a single CSV.
 *
 *   License: Hawaii state government open data (Tier A — state PD-equivalent).
 *
 *   TypeScript port of the bash `fetch-state-hi-schools.sh`, matching the style of the other corpus
 *   fetch scripts (fetch-nad). Built-in `fetch` (gzip/brotli) replaces curl for the download; the
 *   XLSX → CSV step still rides `python3` + `openpyxl` via zx — there is no clean node equivalent
 *   without adding a workbook-parsing dependency.
 *
 *   ## Usage
 *
 *   ```sh
 *   OUT_ROOT=/data/corpus/sources \
 *     npx tsx packages/corpus/scripts/fetch-sources/fetch-state-hi-schools.ts
 *   ```
 *
 *   Defaults to writing under `./data/corpus/sources/` in the repo root. Idempotent: if the dest CSV
 *   exists and sha matches MANIFEST, skips download.
 *
 *   ## Flags
 *
 *   - `--out-root <path>` (env `OUT_ROOT`) — destination root; default `./data/corpus/sources`
 *
 *   ## Dependencies (operator-side)
 *
 *   - `python3` with `openpyxl` (XLSX → CSV)
 *     - Debian/Ubuntu:  `sudo apt-get install -y python3-openpyxl`
 *     - macOS Homebrew: `brew install python && pip3 install openpyxl`
 */

///<reference types="node" />

import { createHash } from "node:crypto"
import { existsSync, mkdirSync, statSync } from "node:fs"
import { readFile, unlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"

import { $ } from "zx"

const SOURCE_URL = "https://www.hawaiipublicschools.org/DOE%20Forms/SchoolList.xlsx"
const SLUG = "state-hi-schools"
const CSV_FILENAME = "HI_Public_Schools_List.csv"
const XLSX_FILENAME = "HI_Public_Schools_List.xlsx"

/**
 * The XLSX → CSV converter: concatenate every sheet under one shared header (the first sheet's). Runs as `python3 -c
 * <script> <xlsx-path> <csv-path>`, so `sys.argv[1]`/`sys.argv[2]` are the I/O paths.
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

function parseCLIArgs() {
	const { values } = parseArgs({
		options: {
			"out-root": { type: "string", default: process.env.OUT_ROOT ?? "data/corpus/sources" },
		},
	})

	return { outRoot: values["out-root"]! }
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

async function sha256OfFile(path: string): Promise<string> {
	return createHash("sha256")
		.update(await readFile(path))
		.digest("hex")
}

async function main(): Promise<void> {
	$.verbose = false
	const opts = parseCLIArgs()
	const destDir = join(opts.outRoot, SLUG)
	mkdirSync(destDir, { recursive: true })

	const xlsxDest = join(destDir, XLSX_FILENAME)
	const csvDest = join(destDir, CSV_FILENAME)
	const manifestPath = join(destDir, "MANIFEST.json")

	process.stderr.write(`=== ${SLUG}\n`)

	// Idempotency: skip if CSV exists and sha matches recorded MANIFEST.
	if (existsSync(manifestPath) && existsSync(csvDest)) {
		try {
			const recorded = JSON.parse(await readFile(manifestPath, "utf8")) as Partial<Manifest>

			if (recorded.sha256 && recorded.filename === CSV_FILENAME) {
				const actualSha = await sha256OfFile(csvDest)

				if (actualSha === recorded.sha256) {
					process.stderr.write(`  ✓ Already current (sha256 matches MANIFEST) — skipping download.\n`)

					return
				}
			}
		} catch {
			// Corrupt manifest — fall through and re-fetch.
		}
	}

	// Preflight: openpyxl must be importable.
	const preflight = await $({ nothrow: true })`python3 -c ${"import openpyxl"}`

	if (preflight.exitCode !== 0) {
		process.stderr.write(
			`  ✗ python3 with the \`openpyxl\` package is required to convert the HIDOE XLSX.\n` +
				`    Debian/Ubuntu:  sudo apt-get install -y python3-openpyxl\n` +
				`    macOS Homebrew: brew install python && pip3 install openpyxl\n`
		)
		process.exitCode = 1

		return
	}

	// Download XLSX.
	process.stderr.write(`  Downloading ${SOURCE_URL} ...\n`)
	const res = await fetch(SOURCE_URL, {
		headers: { "Accept-Encoding": "gzip, br" },
		signal: AbortSignal.timeout(600_000),
	})

	if (!res.ok) {
		process.stderr.write(`  ✗ Download failed (HTTP ${res.status} ${res.statusText})\n`)
		process.exitCode = 1

		return
	}
	await writeFile(xlsxDest, Buffer.from(await res.arrayBuffer()))

	const xlsxSize = statSync(xlsxDest).size
	process.stderr.write(`  Downloaded XLSX: ${iec(xlsxSize)}\n`)

	if (xlsxSize < 1024) {
		process.stderr.write(`  ✗ Response too small (${xlsxSize} bytes) — probable error page\n`)
		process.exitCode = 1

		return
	}

	// Convert XLSX → CSV (concatenate both sheets under one shared header).
	process.stderr.write(`  Converting XLSX → CSV (concatenating sheets) ...\n`)
	await $({ stdio: ["ignore", "inherit", "inherit"] })`python3 -c ${PY_CONVERT} ${xlsxDest} ${csvDest}`

	const csvSize = statSync(csvDest).size
	const csvSha = await sha256OfFile(csvDest)

	// Remove XLSX (CSV is the canonical artifact the adapter consumes).
	await unlink(xlsxDest)
	process.stderr.write(`  Removed XLSX (CSV kept)\n`)

	// Write MANIFEST.
	const manifest: Manifest = {
		source_url: SOURCE_URL,
		downloaded_at: new Date().toISOString(),
		filename: CSV_FILENAME,
		sha256: csvSha,
		bytes: csvSize,
		notes: "Converted from XLSX (sheets HIDOE + PCS concatenated under shared header).",
	}
	await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n")

	process.stderr.write(`  ✓ ${iec(csvSize)}  sha256=${csvSha}\n`)
	process.stderr.write(`  MANIFEST written to ${manifestPath}\n`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	main().catch((err: Error) => {
		process.stderr.write(`fatal: ${err.message}\n${err.stack}\n`)
		process.exitCode = 1
	})
}
