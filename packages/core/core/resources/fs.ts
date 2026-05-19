/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { Stats } from "node:fs"
import { readFile, stat } from "node:fs/promises"
import { PathBuilderLike } from "path-ts"

/**
 * Attempts to stat a file or directory.
 */
export function tryStat(pathBuilderLike: PathBuilderLike): Promise<Stats | null> {
	return stat(pathBuilderLike).catch(() => null)
}

/**
 * Read a file and yield each line, with no trailing newline.
 *
 * Bypasses `TextSpliterator.fromAsync` because of an upstream bug in spliterator's end-of-file
 * buffer compression that fires on files crossing specific chunk-boundary arithmetic — notably
 * `resources/libpostal/dictionaries/all/given_names.txt` (96 KB) and WOF placetype files above ~78
 * KB. Until the upstream fix lands, slurping is fine: every dictionary file in this repo is well
 * under a megabyte.
 */
export async function* readLines(filePath: PathBuilderLike): AsyncIterable<string> {
	const buf = await readFile(filePath as string)
	const text = buf.toString("utf-8")
	let start = 0
	for (let i = 0; i < text.length; i++) {
		if (text.charCodeAt(i) === 0x0a) {
			yield text.slice(start, i)
			start = i + 1
		}
	}
	if (start < text.length) yield text.slice(start)
}
