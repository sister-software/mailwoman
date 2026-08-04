/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Streaming CSV reader for the ported OpenAddresses eval builders (`build-fr-golden-diversified`,
 *   `build-oa-coord-golden`, `sample-oa-zip`). The Python originals used `csv.DictReader` over a
 *   `zipfile` entry; this is the TS equivalent.
 *
 *   Why spawn `unzip -p` rather than a JS unzip library: the national OA dumps are ZIP64 archives
 *   whose CSV member exceeds 4 GB (FR BAN), and the read must STREAM (OOM-safe). `unzip -p` streams
 *   a single member to stdout; Debian's UnZip 6.00 has ZIP64 + large-file support compiled in. (The
 *   Python notes warned `unzip -p` "chokes on ZIP64" — that predated the 6.00 LFS build; if a
 *   future archive ever regresses, the fallback is a Node ZIP64 local-header reader.) This mirrors
 *   the established `(retired) ingest-openaddresses` pattern of spawning system zip
 *   tooling.
 *
 *   The CSV options are tuned to match Python's lenient `csv.DictReader`: missing trailing columns
 *   read as `""`, extra columns land under `column_<n>`, and a malformed row is split rather than
 *   aborting the stream.
 */

import { spawn, spawnSync } from "node:child_process"
import { createReadStream } from "node:fs"

import { CSVSpliterator, type CSVSpliteratorInit } from "spliterator"

/**
 * Spliterator options approximating Python's default `csv.DictReader` dialect + leniency.
 *
 * `normalizeKeys: false` keeps the source's own header spelling, which is what callers index by (`row.NUMBER`,
 * `row.STREET` — OpenAddresses ships ALL-CAPS headers). Quote handling is ON: OA street and city fields wrap embedded
 * commas, and the spliterator leaves quoting off by default.
 */
const CSV_OPTS: CSVSpliteratorInit = {
	mode: "object",
	normalizeKeys: false,
	enableQuoteHandling: true,
}

/**
 * Drop a leading UTF-8 BOM from a byte stream.
 *
 * The spliterator has no BOM option, and a BOM survives into the FIRST HEADER NAME — `﻿LON` instead of `LON` — so every
 * row would read that column as absent while the rest parsed fine.
 */
async function* withoutBOM(source: AsyncIterable<Uint8Array | string>): AsyncIterable<Uint8Array> {
	let first = true

	for await (const chunk of source) {
		let bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk

		if (first) {
			first = false

			if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
				bytes = bytes.subarray(3)
			}
		}

		yield bytes
	}
}

/**
 * Return the first `.csv` member name inside `zipPath` (Python `[n for n in namelist() ...][0]`).
 */
export function firstCSVEntry(zipPath: string): string {
	const r = spawnSync("unzip", ["-Z1", zipPath], { encoding: "utf8", maxBuffer: 1 << 28 })

	const names = (r.stdout || "")
		.split("\n")
		.map((s) => s.trim())
		.filter(Boolean)

	const csv = names.find((n) => n.endsWith(".csv"))

	if (!csv) throw new Error(`no .csv entry found in ${zipPath}`)

	return csv
}

/**
 * Stream header-keyed CSV records from a single member of a (possibly ZIP64) zip archive.
 */
export async function* csvRecordsFromZip(
	zipPath: string,
	entry: string
): AsyncGenerator<Record<string, string | undefined>> {
	const child = spawn("unzip", ["-p", zipPath, entry], { stdio: ["ignore", "pipe", "inherit"] })
	child.on("error", () => {})
	// Swallow the late "premature close" raised when the stream is destroyed on an early break;
	// errors DURING iteration still reject into the consumer's for-await.
	child.stdout!.on("error", () => {})

	try {
		for await (const rec of CSVSpliterator.fromAsync(withoutBOM(child.stdout!), CSV_OPTS)) {
			yield rec as Record<string, string | undefined>
		}
	} finally {
		child.stdout?.destroy()

		try {
			child.kill("SIGKILL")
		} catch {
			/* the child has already exited */
		}
	}
}

/**
 * Stream header-keyed CSV records from a loose CSV file on disk.
 */
export async function* csvRecordsFromFile(path: string): AsyncGenerator<Record<string, string | undefined>> {
	for await (const rec of CSVSpliterator.fromAsync(withoutBOM(createReadStream(path)), CSV_OPTS)) {
		yield rec as Record<string, string | undefined>
	}
}
