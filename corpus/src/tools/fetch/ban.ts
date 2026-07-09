/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Fetch the full French BAN (Base Adresse Nationale) — all metropolitan départements (01-95, 2A,
 *   2B) plus 5 overseas DOM/TOM (971-976 excl. 975).
 *
 *   Source: https://adresse.data.gouv.fr/data/ban/adresses/latest/csv/
 *   Licence: Licence Ouverte 2.0 (attribution required — Tier B).
 *
 *   Files already present with matching sha256 are skipped (re-runnable). Downloads `.csv.gz`,
 *   decompresses to `.csv`, deletes the `.gz` artifact. One shared `MANIFEST.json` at
 *   `<outRoot>/ban/MANIFEST.json` covers all codes.
 *
 *   Invoke via `mailwoman corpus fetch ban --out-root <path>`. Built-in `fetch` with gzip/brotli
 *   decompression replaces curl; native `node:zlib` gunzip replaces the `gunzip` subprocess; no
 *   Python.
 */

import { existsSync, mkdirSync, statSync } from "node:fs"
import { readFile, unlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { gunzipSync } from "node:zlib"

import { sha256File } from "@mailwoman/core/utils"

import type { BaseFetchOptions, FetchSummary } from "./download.ts"
import { downloadToFile, loadManifestEntries, writeManifest } from "./download.ts"

const BASE_URL = "https://adresse.data.gouv.fr/data/ban/adresses/latest/csv"

/**
 * All département codes — metropolitan 01-95 (with 2A/2B for Corsica instead of 20) plus overseas DOM/TOM. Codes do not
 * change.
 */
const DEPT_CODES = [
	"01",
	"02",
	"03",
	"04",
	"05",
	"06",
	"07",
	"08",
	"09",
	"10",
	"11",
	"12",
	"13",
	"14",
	"15",
	"16",
	"17",
	"18",
	"19",
	"21",
	"22",
	"23",
	"24",
	"25",
	"26",
	"27",
	"28",
	"29",
	"2A",
	"2B",
	"30",
	"31",
	"32",
	"33",
	"34",
	"35",
	"36",
	"37",
	"38",
	"39",
	"40",
	"41",
	"42",
	"43",
	"44",
	"45",
	"46",
	"47",
	"48",
	"49",
	"50",
	"51",
	"52",
	"53",
	"54",
	"55",
	"56",
	"57",
	"58",
	"59",
	"60",
	"61",
	"62",
	"63",
	"64",
	"65",
	"66",
	"67",
	"68",
	"69",
	"70",
	"71",
	"72",
	"73",
	"74",
	"75",
	"76",
	"77",
	"78",
	"79",
	"80",
	"81",
	"82",
	"83",
	"84",
	"85",
	"86",
	"87",
	"88",
	"89",
	"90",
	"91",
	"92",
	"93",
	"94",
	"95",
	"971",
	"972",
	"973",
	"974",
	"976",
]

export interface BanManifestEntry {
	dept_code: string
	filename: string
	source_url: string
	downloaded_at: string
	sha256: string
	bytes: number
}

export type FetchBanOptions = BaseFetchOptions

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

export async function fetchBan(options: FetchBanOptions, report?: (line: string) => void): Promise<FetchSummary> {
	const banDir = join(options.outRoot, "ban")
	const manifestPath = join(banDir, "MANIFEST.json")
	mkdirSync(banDir, { recursive: true })

	// Load existing entries (code -> entry): skip detection + preservation of untouched codes.
	const entries = await loadManifestEntries<BanManifestEntry>(manifestPath, (entry) => entry.dept_code)

	let fetched = 0
	let skipped = 0
	let failed = 0
	const failedCodes: string[] = []

	for (const code of DEPT_CODES) {
		const filename = `adresses-${code}.csv`
		const gzFile = join(banDir, `${filename}.gz`)
		const csvFile = join(banDir, filename)
		const url = `${BASE_URL}/adresses-${code}.csv.gz`

		report?.(`=== dept ${code}`)

		// If the CSV already exists, compare its sha256 against the manifest.
		if (existsSync(csvFile)) {
			const existingSha = await sha256File(csvFile)
			const recordedSha = entries.get(code)?.sha256

			if (recordedSha && existingSha === recordedSha) {
				report?.(`  → already present + sha matches — skipping`)
				skipped++
				continue
			}

			report?.(`  → present but sha mismatch or no manifest entry — re-fetching`)
			await unlink(csvFile)
		}

		// Download the gzipped CSV.
		try {
			await downloadToFile({
				url,
				dest: gzFile,
				timeoutMs: 600_000,
				headers: { "Accept-Encoding": "gzip, br" },
				report,
			})
		} catch (err) {
			report?.(`  ✗ download failed: ${url} (${(err as Error).message})`)
			failed++
			failedCodes.push(code)
			continue
		}

		// Guard against truncated 404/error pages.
		const gzSize = statSync(gzFile).size

		if (gzSize < 1024) {
			report?.(`  ✗ response too small (${gzSize} bytes) — probable 404 / error page`)
			await unlink(gzFile)
			failed++
			failedCodes.push(code)
			continue
		}

		// Decompress in-place; delete the .gz.
		try {
			await writeFile(csvFile, gunzipSync(await readFile(gzFile)))
		} catch (err) {
			report?.(`  ✗ decompress failed: ${(err as Error).message}`)
			await unlink(gzFile)
			failed++
			failedCodes.push(code)
			continue
		}
		await unlink(gzFile)

		if (!existsSync(csvFile)) {
			report?.(`  ✗ decompressed file not found at ${csvFile}`)
			failed++
			failedCodes.push(code)
			continue
		}

		const bytes = statSync(csvFile).size
		const sha = await sha256File(csvFile)

		entries.set(code, {
			dept_code: code,
			filename,
			source_url: url,
			downloaded_at: new Date().toISOString(),
			sha256: sha,
			bytes,
		})

		report?.(`  ✓ ${iec(bytes)}  sha256=${sha}`)
		fetched++

		// Be a polite citizen — short pause between requests.
		await sleep(200)
	}

	// Write the consolidated MANIFEST.json (entries sorted by dept_code, codepoint order).
	const sorted = [...entries.values()].sort((a, b) =>
		a.dept_code < b.dept_code ? -1 : a.dept_code > b.dept_code ? 1 : 0
	)
	await writeManifest(manifestPath, sorted)
	report?.(`Wrote ${manifestPath} with ${sorted.length} entries.`)

	report?.(`=== summary ===`)
	report?.(`fetched:  ${fetched}`)
	report?.(`skipped:  ${skipped} (already present + sha matched)`)
	report?.(`failed:   ${failed}`)

	if (failedCodes.length > 0) {
		report?.(`failed codes: ${failedCodes.join(" ")}`)
	}

	return { fetched, skipped, failed, failedCodes }
}
