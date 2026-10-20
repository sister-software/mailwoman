/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Reads corpus rows from a parquet file of either schema, mapped to the current columns.
 *
 *   A corpus file written before #2741 holds `corpus_version` and `recipe` columns, and a current one holds
 *   `augmentation`. The training configs still point at v0.7.x corpora, so a tool that reads rows reads both.
 *   {@linkcode corpusRowFromParquet} in `#parquet/schema` is the one mapping, and this stream applies it, so no
 *   caller branches on the schema.
 */

import type { PathBuilderLike } from "path-ts"

import { parquetColumnNames } from "#parquet/readers"
import { corpusRowFromParquet, type ParquetRow } from "#parquet/schema"
import { openParquetRowStream, type ParquetRowStreamOptions } from "#parquet/streams"

/**
 * The columns an older file is read through when a caller projects `augmentation`.
 */
const AUGMENTATION_SOURCE_COLUMNS = ["recipe", "base_source_id"] as const

/**
 * Open a stream of corpus rows over a parquet file of either schema.
 *
 * A projection names current columns.
 * On an older file `augmentation` is read from `recipe` and `base_source_id`,
 * and `base_source_id` is dropped again unless the caller asked for it.
 *
 * Any other column the file lacks raises, as {@linkcode openParquetRowStream} does.
 */
export async function* openCorpusRowStream<T extends Partial<ParquetRow> = ParquetRow>(
	path: PathBuilderLike,
	options: ParquetRowStreamOptions = {}
): AsyncGenerator<T> {
	const { columns } = options
	const wantsAugmentation = columns?.includes("augmentation") ?? false
	const retired = wantsAugmentation && !(await parquetColumnNames(path)).includes("augmentation")

	const projection = retired
		? [...new Set([...columns!.filter((column) => column !== "augmentation"), ...AUGMENTATION_SOURCE_COLUMNS])]
		: columns

	const keepBaseSourceID = !retired || columns!.includes("base_source_id")

	for await (const raw of openParquetRowStream<Record<string, unknown>>(path, { ...options, columns: projection })) {
		const row = corpusRowFromParquet(raw) as Record<string, unknown>

		if (!keepBaseSourceID) {
			delete row["base_source_id"]
		}

		yield row as T
	}
}
