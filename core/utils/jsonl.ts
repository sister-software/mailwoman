/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   JSON Lines helpers, all three DEPRECATED — `spliterator` covers the whole surface, and a thin
 *   wrapper in front of it only hides which half you are getting.
 *
 *   - `readJSONL` → `Array.fromAsync(JSONSpliterator.fromAsync<T>(path))`
 *   - `iterateJSONL` → `JSONSpliterator.fromAsync<T>(path)`
 *   - `writeJSONL` → `createNewlineWriter(path)`
 *
 *   Kept exported because `@mailwoman/core` is published; they go in the next major.
 */

import { readFileSync, writeFileSync } from "node:fs"

import { TextSpliterator } from "spliterator"

/**
 * Read an entire JSONL file into memory. Blank and whitespace-only lines are skipped.
 *
 * @deprecated Use `Array.fromAsync(JSONSpliterator.fromAsync<T>(path))` from `spliterator`. This buffers the whole file
 *   as one string, which throws `ERR_STRING_TOO_LONG` past V8's 512 MiB cap.
 */
export function readJSONL<T>(path: string): T[] {
	return readFileSync(path, "utf8")
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as T)
}

/**
 * Write rows as JSONL (one `JSON.stringify` per line, trailing newline). Returns the row count.
 *
 * @deprecated Use `createNewlineWriter(path)` from `spliterator`. This concatenates every row into one string before it
 *   writes anything, so the output is capped the same way the input is.
 */
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

/**
 * Stream a JSONL file row-by-row without loading it whole. Blank lines are skipped.
 *
 * @deprecated Use `JSONSpliterator.fromAsync<T>(path)` from `spliterator` — this is a decode-then-parse wrapper around
 *   exactly that.
 */
export async function* iterateJSONL<T>(path: string): AsyncIterable<T> {
	for await (const line of TextSpliterator.fromAsync(path)) {
		if (!line.trim()) continue
		yield JSON.parse(line) as T
	}
}
