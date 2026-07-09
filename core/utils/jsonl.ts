/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   JSON Lines helpers — the canonical home for the `split("\n") + JSON.parse` idiom that was
 *   re-rolled across ~88 scripts (2026-07-09 dedupe survey). `iterateJSONL` streams via spliterator
 *   for files too large to slurp.
 */

import { readFileSync, writeFileSync } from "node:fs"

import { TextSpliterator } from "spliterator"

/** Read an entire JSONL file into memory. Blank and whitespace-only lines are skipped. */
export function readJSONL<T>(path: string): T[] {
	return readFileSync(path, "utf8")
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as T)
}

/** Write rows as JSONL (one `JSON.stringify` per line, trailing newline). Returns the row count. */
export function writeJSONL(path: string, rows: Iterable<unknown>): number {
	let count = 0
	let out = ""

	for (const row of rows) {
		out += JSON.stringify(row) + "\n"
		count++
	}
	writeFileSync(path, out, "utf8")

	return count
}

/** Stream a JSONL file row-by-row without loading it whole. Blank lines are skipped. */
export async function* iterateJSONL<T>(path: string): AsyncIterable<T> {
	for await (const line of TextSpliterator.fromAsync(path)) {
		if (!line.trim()) continue
		yield JSON.parse(line) as T
	}
}
