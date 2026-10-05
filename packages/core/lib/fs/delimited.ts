/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Reads a delimited file whose `"` is an ordinary character.
 *
 *   `CSVSpliteratorInit.enableQuoteHandling` defaults to true.
 *   A quote-aware reader over unquoted input still returns rows.
 *   It joins every line between one `"` and the next into one record.
 *   The caller then sees a shorter file and reads a smaller dataset.
 *   Downstream counts cannot distinguish this result from a small source file.
 *
 *   The GeoNames country dumps are unquoted TSV and contain `"` in place names (`Ovrag Kyzylak"on`).
 *
 *   A quote-aware reader of CSV text indexes its header with {@linkcode headerColumnIndex} and passes its
 *   record count to {@linkcode checkRecordCount}. A quote that never closes shortens that read in the same way.
 */

import { createReadStream } from "node:fs"

import type { PathBuilderLike } from "path-ts"
import { TextSpliterator, TSVSpliterator } from "spliterator"
import type { AsyncDataResource } from "spliterator"

import { zstdDecompressor } from "#fs/compression"
import { tryStat } from "#fs/readers/stat"

/**
 * Stream the records of an unquoted tab-separated file, for any source whose `"` is literal.
 *
 * The GeoNames dumps and every register that writes plain TSV are such sources.
 *
 * A genuinely quoted source, such as a spreadsheet export or a register that escapes
 * delimiters, should use `TSVSpliterator` with its default settings.
 * State that choice where the source is read.
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
 * A reader that can return a partial result must state how many rows it read or throw.
 * Consumers see the same count for a short read and a small file.
 *
 * A gazetteer build may then mistake the short read for an absent entry.
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
 * Maps each label of a header row to its column index, and throws when a label repeats.
 *
 * `file` identifies the file in the error message.
 */
export function headerColumnIndex(file: string, header: readonly string[]): Map<string, number> {
	const columns = new Map<string, number>()

	for (const [index, label] of header.entries()) {
		if (columns.has(label)) throw new Error(`${file} repeats the header column "${label}".`)

		columns.set(label, index)
	}

	return columns
}

/**
 * Throws when the count of records parsed from a delimited text differs from the text's count of data lines.
 *
 * The first non-empty line of `text` is its header, and each later non-empty line is a data line.
 *
 * A quote-aware reader joins every line after a quote that never closes into one record.
 * The read then answers short with no other sign, so a reader of quoted text compares the two counts.
 */
export function checkRecordCount(file: string, text: string, records: number): void {
	const dataLines = TextSpliterator.from(text).toArray().length - 1

	if (records !== dataLines) throw new Error(`${file}: read ${records} records from ${dataLines} data lines.`)
}

/**
 * The extension that marks a delimited file as zstd-compressed at rest.
 */
export const ZSTD_EXTENSION = ".zst"

/**
 * A byte source for a delimited file, transparently decompressing a `.zst` input.
 *
 * Call this inline at each read.
 * The function returns an uncompressed path unchanged.
 *
 * Each spliterator opens that path independently.
 * That lets {@linkcode readUnquotedTSVChecked} count a file and then read it.
 *
 * A compressed file becomes a single stream.
 * The reader cannot reuse that stream across two passes: it yields the rows once
 * and no rows the second time.
 *
 * A compressed source is not seekable, so it cannot be segmented for parallel readers.
 * Every reader in this repository consumes a corpus part file as one stream.
 * The function buffers no bytes in either case.
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
