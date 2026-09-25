/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Merges one source's overlay parquet files into shuffled output files.
 *
 *   The training sampler can read a whole per-source draw from one row group,
 *   so a source split into per-country files would reach only one country per draw.
 *   Shuffling across the inputs mixes the source's countries within each row group.
 */

import { mulberry32 } from "@mailwoman/core/utils"
import type { PathBuilderLike } from "path-ts"

import { type ParquetRow, ROWS_PER_FILE } from "#parquet/schema"
import { DEFAULT_SHUFFLE_SEED, DEFAULT_SHUFFLE_WINDOW, shuffleWithinWindow } from "#parquet/shuffle"
import { openParquetRowStream } from "#parquet/streams"
import { writeParquetFile } from "#parquet/writers"

/**
 * Options for {@link mergeSourceFiles}.
 */
export interface MergeSourceOptions {
	/**
	 * The parquet files to merge, read in the order given.
	 */
	inputs: readonly PathBuilderLike[]
	/**
	 * The output path, whose stem receives a five-digit index for each file written.
	 */
	output: PathBuilderLike
	/**
	 * The number of rows held in memory while shuffling, which defaults to the corpus writer's window.
	 */
	windowSize?: number
	/**
	 * The shuffle seed.
	 *
	 * The default is the corpus writer's seed, which makes rebuilds reproducible.
	 */
	seed?: number
	/**
	 * The maximum rows per output file.
	 *
	 * `writeParquetFile` builds one Arrow table per file, and Arrow's list builder
	 * overflows on very large tables.
	 */
	rowsPerFile?: number
}

/**
 * The files that {@link mergeSourceFiles} wrote and the row counts they hold.
 */
export interface MergeSourceResult {
	inputs: readonly string[]
	/**
	 * The files written, in order.
	 */
	outputs: readonly string[]
	rows: number
	/**
	 * Row counts per `country` value.
	 */
	byCountry: Record<string, number>
	/**
	 * Row counts per `source` value, which has one entry after a successful merge.
	 */
	bySource: Record<string, number>
}

async function* readAll(inputs: readonly PathBuilderLike[]): AsyncGenerator<ParquetRow> {
	for (const input of inputs) {
		yield* openParquetRowStream<ParquetRow>(input)
	}
}

/**
 * Merges the inputs through a windowed shuffle into one or more parquet files and reports their contents.
 *
 * @throws When the inputs carry more than one `source`, because a manifest
 * entry records one source per file.
 * The check runs after the stream ends, so files flushed before it remain on disk.
 */
export async function mergeSourceFiles(options: MergeSourceOptions): Promise<MergeSourceResult> {
	const inputs = options.inputs.map((input) => input.toString())
	const random = mulberry32(options.seed ?? DEFAULT_SHUFFLE_SEED)
	const rowsPerFile = options.rowsPerFile ?? ROWS_PER_FILE
	const stem = options.output.toString().replace(/\.parquet$/u, "")

	const byCountry: Record<string, number> = {}
	const bySource: Record<string, number> = {}
	const outputs: string[] = []
	let pending: ParquetRow[] = []
	let rows = 0

	const flush = async (): Promise<void> => {
		if (!pending.length) return

		const output = `${stem}-${String(outputs.length).padStart(5, "0")}.parquet`

		await writeParquetFile(pending, output)
		outputs.push(output)
		pending = []
	}

	for await (const row of shuffleWithinWindow(
		readAll(options.inputs),
		random,
		options.windowSize ?? DEFAULT_SHUFFLE_WINDOW
	)) {
		pending.push(row)

		rows++
		byCountry[row.country] = (byCountry[row.country] ?? 0) + 1
		bySource[row.source] = (bySource[row.source] ?? 0) + 1

		if (pending.length >= rowsPerFile) {
			await flush()
		}
	}

	const sources = Object.keys(bySource)

	if (sources.length > 1) {
		throw new Error(
			`the inputs carry ${sources.length} sources (${sources.join(", ")}), and a merged file's manifest entry names one. ` +
				`Merge the files of one source at a time.`
		)
	}

	await flush()

	return { inputs, outputs, rows, byCountry, bySource }
}
