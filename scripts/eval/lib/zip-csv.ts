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
 *   become absent keys (callers already coalesce with `?? ""`), extra columns are dropped, and
 *   malformed records are skipped rather than aborting the stream.
 */

import { spawn, spawnSync } from "node:child_process"
import { createReadStream } from "node:fs"

import { parse, type Options } from "csv-parse"

/** Csv-parse options approximating Python's default `csv.DictReader` dialect + leniency. */
const CSV_OPTS: Options = {
	columns: true,
	bom: true,
	relax_quotes: true,
	relax_column_count: true,
	skip_records_with_error: true,
}

/** Return the first `.csv` member name inside `zipPath` (Python `[n for n in namelist() ...][0]`). */
export function firstCSVEntry(zipPath: string): string {
	const r = spawnSync("unzip", ["-Z1", zipPath], { encoding: "utf-8", maxBuffer: 1 << 28 })
	const names = (r.stdout || "")
		.split("\n")
		.map((s) => s.trim())
		.filter(Boolean)
	const csv = names.find((n) => n.endsWith(".csv"))

	if (!csv) throw new Error(`no .csv entry found in ${zipPath}`)

	return csv
}

/** Stream header-keyed CSV records from a single member of a (possibly ZIP64) zip archive. */
export async function* csvRecordsFromZip(
	zipPath: string,
	entry: string
): AsyncGenerator<Record<string, string | undefined>> {
	const child = spawn("unzip", ["-p", zipPath, entry], { stdio: ["ignore", "pipe", "inherit"] })
	child.on("error", () => {})
	child.stdout!.on("error", () => {})
	const parser = parse(CSV_OPTS)
	// Swallow the late "premature close" error raised when we destroy the stream on an early break;
	// errors DURING iteration still reject into the consumer's for-await.
	parser.on("error", () => {})
	child.stdout!.pipe(parser)

	try {
		for await (const rec of parser) {
			yield rec as Record<string, string | undefined>
		}
	} finally {
		parser.destroy()
		child.stdout?.destroy()

		try {
			child.kill("SIGKILL")
		} catch {
			/* the child has already exited */
		}
	}
}

/** Stream header-keyed CSV records from a loose CSV file on disk. */
export async function* csvRecordsFromFile(path: string): AsyncGenerator<Record<string, string | undefined>> {
	const parser = createReadStream(path).pipe(parse(CSV_OPTS))

	for await (const rec of parser) {
		yield rec as Record<string, string | undefined>
	}
}
