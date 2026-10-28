/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Reads a delimited file whose `"` is an ordinary character.
 *
 *   A quote-aware reader over unquoted input still returns rows.
 *   It joins every line between one `"` and the next into one record.
 *   The caller then sees a shorter file and reads a smaller dataset.
 *   Downstream counts cannot distinguish this result from a small source file.
 *
 *   The GeoNames country dumps are unquoted TSV and contain `"` in place names (`Ovrag Kyzylak"on`).
 *   Since spliterator 10, `TSVSpliterator` reads `"` as data by default, and a quote left open at the end of
 *   the input throws. These readers still pass `enableQuoteHandling: false` so their contract does not rest
 *   on a default.
 *
 *   A quote-aware reader of CSV text indexes its header with {@linkcode headerColumnIndex} and passes its
 *   record count to {@linkcode checkRecordCount}. A quote that opens and closes across lines shortens that
 *   read without an error, so the count check still applies.
 *
 *   Compressed sources are read as given: spliterator decompresses zstd and gzip by their magic bytes, and
 *   reads a path's `.zst` sibling in its place when that exists.
 */

import type { PathBuilderLike } from "path-ts"
import { TextSpliterator, TSVSpliterator } from "spliterator"

/**
 * Stream the records of an unquoted tab-separated file, for any source whose `"` is literal.
 *
 * The GeoNames dumps and every register that writes plain TSV are such sources.
 *
 * A source that quotes its fields, such as a spreadsheet export or a register that escapes
 * delimiters, should use `TSVSpliterator` with `enableQuoteHandling: true`.
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
 * A reader that can return a partial result must state the number of rows it read or throw.
 * Consumers see the same count for a short read and a small file.
 *
 * A gazetteer build may then mistake the short read for an absent entry.
 */
export async function readUnquotedTSVChecked(path: PathBuilderLike): Promise<string[][]> {
	let expected = 0

	// Streamed rather than split, so the check stays cheap enough that a build step always runs it.
	for await (const line of TextSpliterator.fromAsync(path)) {
		if (line) {
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
 * A quote that never closes now throws in the reader.
 * A quote that opens on one line and closes on a later one still joins those lines into one record
 * and answers short with no other sign, so a reader of quoted text compares the two counts.
 */
export function checkRecordCount(file: string, text: string, records: number): void {
	const dataLines = TextSpliterator.from(text).toArray().length - 1

	if (records !== dataLines) throw new Error(`${file}: read ${records} records from ${dataLines} data lines.`)
}
