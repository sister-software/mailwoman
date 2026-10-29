/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The rate at which a tokenizer falls back to raw bytes, overall and per script.
 *
 *   `mtf-tokenizer byte-fallback` encodes each line with the model and assigns it a script from the Unicode name of
 *   its letters, through the tables `mtf-channels` generates from CPython's Unicode database.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { parseJSONStrict } from "@mailwoman/core/json"

import { runMTFTokenizer } from "./binary.ts"

/**
 * One bucket's counts.
 *
 * `rate` is `byte_fallback_pieces / pieces`, or 0 for a bucket with no pieces.
 */
export interface ByteFallbackTally {
	lines: number
	pieces: number
	byte_fallback_pieces: number
	rate: number
}

/**
 * The overall tally and one per script, keyed in the order each script first appeared.
 */
export interface ByteFallbackReport {
	overall: ByteFallbackTally
	per_script: Record<string, ByteFallbackTally>
}

/**
 * Encode each non-blank line of `lines`, stripped, and tally its byte-fallback pieces.
 */
export async function measureByteFallback(model: string, lines: readonly string[]): Promise<ByteFallbackReport> {
	await using scratch = await temporaryDirectory("mtf-byte-fallback-")
	const input = scratch.path("lines.json").toString()

	await writeLocalJSONFile(lines, input)

	const report = await runMTFTokenizer<{
		overall: ByteFallbackTally
		per_script: [string, ByteFallbackTally][]
	}>(["byte-fallback", "--model", model, "--lines", input])

	return { overall: report.overall, per_script: Object.fromEntries(report.per_script) }
}

/**
 * The texts of a held-out fixture: a JSONL file's `raw`, `text` or `input` field
 * per object line, or each line of a plain-text file.
 * Empty lines are skipped.
 */
export async function readFixtureLines(path: string): Promise<string[]> {
	const lines: string[] = []

	for (const line of (await readLocalTextFile(path)).split(/\r\n|\r|\n/)) {
		if (!line) continue

		if (line.trimStart().startsWith("{")) {
			const record = parseJSONStrict<Record<string, unknown>>(line)
			const value = record["raw"] || record["text"] || record["input"]

			if (value) {
				lines.push(String(value))
			}
		} else {
			lines.push(line)
		}
	}

	return lines
}
