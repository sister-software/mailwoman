#!/usr/bin/env npx tsx
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
 *   `$OUT_ROOT/ban/MANIFEST.json` covers all codes.
 *
 *   TypeScript port of the bash `fetch-ban-full.sh`, matching the style of the other corpus fetch
 *   scripts (fetch-nad). Built-in `fetch` with gzip/brotli decompression replaces curl; native
 *   `node:zlib` gunzip replaces the `gunzip` subprocess; no Python.
 *
 *   ## Usage
 *
 *   ```sh
 *   OUT_ROOT=/data/corpus/sources \
 *     npx tsx packages/corpus/scripts/fetch-sources/fetch-ban-full.ts
 *   ```
 *
 *   ## Flags
 *
 *   - `--out-root <path>` (env `OUT_ROOT`) — destination root; default `./data/corpus/sources`
 */

///<reference types="node" />

import { createHash } from "node:crypto"
import { existsSync, mkdirSync, statSync } from "node:fs"
import { readFile, unlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import { gunzipSync } from "node:zlib"

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

interface BanManifestEntry {
	dept_code: string
	filename: string
	source_url: string
	downloaded_at: string
	sha256: string
	bytes: number
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

function sha256OfBuffer(buf: Buffer): string {
	return createHash("sha256").update(buf).digest("hex")
}

async function sha256OfFile(path: string): Promise<string> {
	return sha256OfBuffer(await readFile(path))
}

/** Load any existing MANIFEST.json entries, keyed by `dept_code`, so untouched codes are preserved. */
async function loadExistingEntries(manifestPath: string): Promise<Map<string, BanManifestEntry>> {
	const entries = new Map<string, BanManifestEntry>()

	if (!existsSync(manifestPath)) return entries

	try {
		const parsed = JSON.parse(await readFile(manifestPath, "utf8")) as BanManifestEntry[]

		for (const entry of parsed) entries.set(entry.dept_code, entry)
	} catch {
		// Corrupt/partial manifest — start fresh, all codes re-fetch.
	}

	return entries
}

async function main(): Promise<void> {
	const opts = parseCLIArgs()
	const banDir = join(opts.outRoot, "ban")
	const manifestPath = join(banDir, "MANIFEST.json")
	mkdirSync(banDir, { recursive: true })

	// Load existing entries (code -> entry): skip detection + preservation of untouched codes.
	const entries = await loadExistingEntries(manifestPath)

	let fetched = 0
	let skipped = 0
	let failed = 0
	const failedCodes: string[] = []

	for (const code of DEPT_CODES) {
		const filename = `adresses-${code}.csv`
		const gzFile = join(banDir, `${filename}.gz`)
		const csvFile = join(banDir, filename)
		const url = `${BASE_URL}/adresses-${code}.csv.gz`

		process.stderr.write(`=== dept ${code}\n`)

		// If the CSV already exists, compare its sha256 against the manifest.
		if (existsSync(csvFile)) {
			const existingSha = await sha256OfFile(csvFile)
			const recordedSha = entries.get(code)?.sha256

			if (recordedSha && existingSha === recordedSha) {
				process.stderr.write(`  → already present + sha matches — skipping\n`)
				skipped++
				continue
			}

			process.stderr.write(`  → present but sha mismatch or no manifest entry — re-fetching\n`)
			await unlink(csvFile)
		}

		// Download the gzipped CSV.
		let gzBuffer: Buffer

		try {
			const res = await fetch(url, {
				headers: { "Accept-Encoding": "gzip, br" },
				signal: AbortSignal.timeout(600_000),
			})

			if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
			gzBuffer = Buffer.from(await res.arrayBuffer())
		} catch (err) {
			process.stderr.write(`  ✗ download failed: ${url} (${(err as Error).message})\n`)
			failed++
			failedCodes.push(code)
			continue
		}

		// Persist the .gz, then guard against truncated 404/error pages.
		await writeFile(gzFile, gzBuffer)
		const gzSize = statSync(gzFile).size

		if (gzSize < 1024) {
			process.stderr.write(`  ✗ response too small (${gzSize} bytes) — probable 404 / error page\n`)
			await unlink(gzFile)
			failed++
			failedCodes.push(code)
			continue
		}

		// Decompress in-place; delete the .gz.
		try {
			await writeFile(csvFile, gunzipSync(gzBuffer))
		} catch (err) {
			process.stderr.write(`  ✗ decompress failed: ${(err as Error).message}\n`)
			await unlink(gzFile)
			failed++
			failedCodes.push(code)
			continue
		}
		await unlink(gzFile)

		if (!existsSync(csvFile)) {
			process.stderr.write(`  ✗ decompressed file not found at ${csvFile}\n`)
			failed++
			failedCodes.push(code)
			continue
		}

		const bytes = statSync(csvFile).size
		const sha = await sha256OfFile(csvFile)

		entries.set(code, {
			dept_code: code,
			filename,
			source_url: url,
			downloaded_at: new Date().toISOString(),
			sha256: sha,
			bytes,
		})

		process.stderr.write(`  ✓ ${iec(bytes)}  sha256=${sha}\n`)
		fetched++

		// Be a polite citizen — short pause between requests.
		await new Promise((resolve) => setTimeout(resolve, 200))
	}

	// Write the consolidated MANIFEST.json (entries sorted by dept_code, codepoint order).
	const sorted = [...entries.values()].sort((a, b) =>
		a.dept_code < b.dept_code ? -1 : a.dept_code > b.dept_code ? 1 : 0
	)
	await writeFile(manifestPath, JSON.stringify(sorted, null, 2) + "\n")
	process.stderr.write(`Wrote ${manifestPath} with ${sorted.length} entries.\n`)

	process.stderr.write(`\n=== summary ===\n`)
	process.stderr.write(`fetched:  ${fetched}\n`)
	process.stderr.write(`skipped:  ${skipped} (already present + sha matched)\n`)
	process.stderr.write(`failed:   ${failed}\n`)

	if (failedCodes.length > 0) process.stderr.write(`failed codes: ${failedCodes.join(" ")}\n`)

	if (failed > 0) process.exitCode = 1
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	main().catch((err: Error) => {
		process.stderr.write(`fatal: ${err.message}\n${err.stack}\n`)
		process.exitCode = 1
	})
}
