/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Reading a delimited file whose `"` is an ordinary character.
 *
 *   `CSVSpliteratorInit.enableQuoteHandling` defaults TO true, and a quote-aware reader over an unquoted source does
 *   not fail — it joins every line between one `"` and the next into a single record, so the caller sees a shorter
 *   file and reads it as a smaller dataset. Nothing downstream can tell that apart from a small file, because every
 *   count downstream is derived from what the reader returned.
 *
 *   Measured on the GeoNames country dumps, which are unquoted TSV and carry `"` in place names (`Ovrag Kyzylak"on`):
 *   2,896,186 rows across the 161-country fold set, 2,355,927 records read, **540,259 lost** — Finland 84.4 %,
 *   Azerbaijan 94.7 %, Slovakia 93.1 %, North Korea 82.2 %, Turkmenistan 76.7 %. Türkmenabat, population 230,861,
 *   sits past the first `"` in its dump and vanished from the gazetteer.
 */

import { createReadStream } from "node:fs"

import type { PathBuilderLike } from "path-ts"
import { TextSpliterator, TSVSpliterator } from "spliterator"
import type { AsyncDataResource } from "spliterator"

import { zstdDecompressor } from "#fs/compression"

/**
 * Stream the records of an unquoted tab-separated file.
 *
 * Use this for any source whose `"` is literal.
 * The GeoNames dumps, and every register that writes plain TSV.
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
 * This costs one extra pass over the bytes and is the right default for a build
 * step that will bake its result into a shipped artifact.
 */
export async function readUnquotedTSVChecked(path: PathBuilderLike): Promise<string[][]> {
	let expected = 0

	// Streamed rather than split: the largest dump this guards is Finland's at 552,802 lines,
	// and the point of the check is to be cheap enough that a build step always runs it.
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
			`${String(path)}: read ${rows.length} records from ${expected} lines. A delimited reader that answers short has ` +
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
 * **Call this inline at each read, and never hoist the result.** An uncompressed
 * path is returned unchanged and a spliterator opens it independently every time —
 * which is what lets {@linkcode readUnquotedTSVChecked} count a file and then read it.
 * A compressed one becomes a stream, and spliterator's own documentation is blunt
 * about what that means: `count` notes that "a path or URL is opened independently...
 * an arbitrary async iterable is inherently consumed."
 *
 * Reusing one stream across two passes therefore yields the rows once and nothing the second time,
 * which a checked reader reports as swallowed data and an unchecked one reports as a smaller file.
 *
 * Each call returns a fresh stream, so the count-then-read shape stays correct
 * as long as the call sits at the point of use.
 *
 * What a compressed source gives up is segmentation: `AsyncSpliterator.asManyWorkers`
 * and `asMany` take "a file path or URL (file handles cannot cross threads)", because
 * delimiter-aligned `[start, end)` ranges need a seekable source and a zstd frame is not one.
 * That costs nothing here — spliterator's own guidance is that for `JSON.parse`-per-row
 * work "threads lose (0.3–0.9x)" and plain sequential `fromAsync` is the right primitive —
 * and nothing in this repository segments a corpus part file.
 *
 * It would matter for a scan-dominated pass over an uncompressed file,
 * which is the case to leave uncompressed.
 *
 * Nothing is buffered either way.
 * The part files this exists for are tens of gigabytes decompressed.
 */
export function delimitedSource(path: PathBuilderLike): AsyncDataResource {
	if (!String(path).endsWith(ZSTD_EXTENSION)) return path

	return createReadStream(String(path)).pipe(zstdDecompressor())
}

/**
 * The path a delimited file is read from, preferring a `.zst` sibling when one exists.
 *
 * Lets a corpus be converted one part file at a time: a reader asks for `part-0000.jsonl`
 * and gets the compressed copy if the conversion has reached it, the plain one if it has not.
 */
export async function preferCompressed(path: PathBuilderLike): Promise<PathBuilderLike> {
	const plain = String(path)

	if (plain.endsWith(ZSTD_EXTENSION)) return path

	const { tryStat } = await import("#fs/readers/stat")
	const compressed = `${plain}${ZSTD_EXTENSION}`

	return (await tryStat(compressed)) ? compressed : path
}
