/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Reading a build's own JSONL back, the one reader every phase after the adapters uses.
 */

import type { PathBuilderLike } from "path-ts"
import { JSONSpliterator } from "spliterator"

/**
 * Stream a JSONL file's rows.
 *
 * `JSONSpliterator` yields parsed rows and throws a `SyntaxError` naming the row on a malformed row.
 * It reads the path's `.zst` sibling in its place when that exists, and decompresses it,
 * so a corpus converted to zstd one part at a time reads the same throughout.
 * Each call opens the file again.
 */
export function streamJSONL<T>(path: PathBuilderLike): AsyncIterable<T> {
	return JSONSpliterator.fromAsync<T>(path)
}
