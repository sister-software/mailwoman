/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Reading a delimited file whose `"` is an ordinary character.
 *
 *   `CSVSpliteratorInit.enableQuoteHandling` defaults TO true, and a quote-aware reader over an unquoted source does
 *   not fail — it joins every line between one `"` and the next into a single record, so the caller sees a shorter
 *   file and reads it as a smaller dataset, which is indistinguishable from a small file at every downstream count.
 *
 *   The GeoNames country dumps are unquoted TSV and carry `"` in place names (`Ovrag Kyzylak"on`).
 */

import { createReadStream } from "node:fs"

import type { PathBuilderLike } from "path-ts"
import { TextSpliterator, TSVSpliterator } from "spliterator"
import type { AsyncDataResource } from "spliterator"

import { zstdDecompressor } from "#fs/compression"
import { tryStat } from "#fs/readers/stat"

/**
 * Stream the records of an unquoted tab-separated file, for any source whose `"` is literal —
 * the GeoNames dumps and every register that writes plain TSV.
 *
 * A source that really is quoted (a spreadsheet export, a register that escapes its delimiters)
 * wants `TSVSpliterator` directly with the default, and should say so where it is read.
 */
export function readUnquotedTSV(path: PathBuilderLike): AsyncIterable<string[]> {
	return TSVSpliterator.fromAsync(path, {
		header: false,
		enableQuoteHandling: false,
	}) as AsyncIterable<string[]>
}

/**
 * The same rule over a string already in memory, for a caller that read the file itself.
 */
export function readUnquotedTSVText(text: string): Iterable<string[]> {
	return TSVSpliterator.from(text, {
		header: false,
		enableQuoteHandling: false,
	}) as Iterable<string[]>
}

/**
 * The same read, checked against the file's own line count, raising rather than answering short.
 *
 * A reader that can return a partial result must say what it got or throw: a short read
 * and a small file are the same number to every consumer, and absence is the answer a
 * gazetteer build is looking for, so the wrong answer arrives looking like a discovery.
 */
export async function readUnquotedTSVChecked(path: PathBuilderLike): Promise<string[][]> {
	let expected = 0

	// Streamed rather than split, so the check stays cheap enough that a build step always runs it.
	for await (const line of TextSpliterator.fromAsync(path)) {
		if (line.length) {
			expected++
		}
	}

	const rows: string[][] = []

	for await (const row of readUnquotedTSV(path)) {
		rows.push(row)
	}

	if (rows.length !== expected) {
		throw new Error(
			`${path}: read ${rows.length} records from ${expected} lines. A delimited reader that answers short has ` +
				`swallowed rows into a quoted region or a stray delimiter, and the shortfall is indistinguishable from a ` +
				`smaller file at every later boundary.`
		)
	}

	return rows
}

/**
 * The extension that marks a delimited file as zstd-compressed at rest.
 */
export const ZSTD_EXTENSION = ".zst"

/**
 * A byte source for a delimited file, transparently decompressing a `.zst` input.
 *
 * Call this inline at each read and never hoist the result: an uncompressed path
 * is returned unchanged and a spliterator opens it independently every time,
 * which is what lets {@linkcode readUnquotedTSVChecked} count a file and then read it,
 * while a compressed one becomes a single stream.
 * Reusing that stream across two passes yields the rows once and no rows the second time.
 *
 * A compressed source is not seekable, so the segmentation `asManyWorkers`
 * and `asMany` need is unavailable; no code in this repository segments a corpus
 * part file, and no bytes are buffered either way.
 */
export function delimitedSource(path: PathBuilderLike): AsyncDataResource {
	if (!path.toString().endsWith(ZSTD_EXTENSION)) return path

	return createReadStream(path.toString()).pipe(zstdDecompressor())
}

/**
 * The path a delimited file is read from, preferring a `.zst` sibling when one exists,
 * so a corpus can be converted one part file at a time: a reader asks for `part-0000.jsonl`
 * and gets the compressed copy if the conversion has reached it, the plain one if it has not.
 */
export async function preferCompressed(path: PathBuilderLike): Promise<PathBuilderLike> {
	const plain = path.toString()

	if (plain.endsWith(ZSTD_EXTENSION)) return path

	const compressed = `${plain}${ZSTD_EXTENSION}`

	return (await tryStat(compressed)) ? compressed : path
}
