/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   JSON Lines helpers, both DEPRECATED — `spliterator` covers the whole surface, and a thin wrapper
 *   in front of it only hides which half you are getting.
 *
 *   - `iterateJSONL` → `JSONSpliterator.fromAsync<T>(path)`
 *   - `writeJSONL` → `createNewlineWriter(path)`
 *
 *   Kept exported because `@mailwoman/core` is published; they go in the next major.
 */

import { writeFileSync } from "@mailwoman/platform/fs"
import { TextSpliterator } from "spliterator"

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
		// oxlint-disable-next-line no-restricted-properties -- Throw-on-corrupt is this function's shipped contract.
		yield JSON.parse(line) as T
	}
}
