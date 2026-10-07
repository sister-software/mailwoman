/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * This module reads a delimited file's header line and refuses one that drops a column an adapter
 * indexes.
 *
 * A fetch module checks the file it just wrote against the columns its adapter reads by name,
 * because a renamed column reaches the adapter as an empty string on every row rather than as an
 * error. The check belongs here rather than in each publisher's module: every caller needs the same
 * two steps, and each one that wrote them again would also be a second answer to how the file is
 * parsed.
 */

import type { PathBuilderLike } from "path-ts"
import { CSVSpliterator } from "spliterator"

/**
 * The header line's column names.
 *
 * Read through `CSVSpliterator`, which is the reader the adapters use, rather than through
 * a split of a fetch module's own: which columns a publisher quotes is a property of
 * the edition, and a second reader would be a second answer to that question.
 * `columnScan: "rows"` keeps the first row from decoding the whole file.
 * The default `"auto"` decodes the whole file even for one row.
 *
 * @param path The written file.
 * @param columnDelimiter The publisher's delimiter. Defaults to a comma.
 * @throws When the file holds no row at all, so an empty or truncated file reports itself
 * rather than reading as a file with no columns.
 */
export async function readDelimitedHeader(path: PathBuilderLike, columnDelimiter?: string): Promise<readonly string[]> {
	const [header] = await Array.fromAsync(
		CSVSpliterator.fromAsync<string[]>(path, {
			header: false,
			mode: "array",
			columnScan: "rows",
			take: 1,
			...(columnDelimiter === undefined ? {} : { columnDelimiter }),
		})
	)

	if (!header) {
		throw new Error(`${path.toString()}: the file holds no row, so its header could not be read`)
	}

	return header
}

/**
 * Refuse a header that does not name every column a caller reads.
 *
 * @param columns The header {@linkcode readDelimitedHeader} returned.
 * @param required The columns the adapter indexes by name.
 * @param context What is being checked. This value opens the message.
 * @throws Naming the columns that are absent, so a renamed column is a reported failure
 * rather than an empty string on every row the adapter emits.
 */
export function assertHeaderColumns(columns: readonly string[], required: readonly string[], context: string): void {
	const present = new Set(columns)
	const absent = required.filter((column) => !present.has(column))

	if (absent.length) {
		throw new Error(
			`${context}: the header names ${columns.length} columns and not ${absent.join(", ")}, which the adapter reads by name`
		)
	}
}
