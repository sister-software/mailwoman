/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Reading a build's own JSONL back, the one reader every phase after the adapters uses.
 */

import { delimitedSource, preferCompressed } from "@mailwoman/core/fs/delimited"
import type { PathBuilderLike } from "path-ts"
import { JSONSpliterator } from "spliterator"

/**
 * Stream a JSONL file's rows.
 *
 * `JSONSpliterator` yields parsed rows and throws `SyntaxError` on a malformed row.
 * `preferCompressed` and `delimitedSource` are called inline because each yields
 * a source that may only be consumed once.
 */
export async function* streamJSONL<T>(path: PathBuilderLike): AsyncIterable<T> {
	yield* JSONSpliterator.fromAsync<T>(delimitedSource(await preferCompressed(path)))
}
