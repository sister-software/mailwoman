/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Merge one source's overlay parquet files into a single shuffled file.
 *
 *   `buildCorpus` shuffles rows before writing them, so a base file's row-group is a sample of its
 *   source rather than a run of one country. An overlay parquet written by `jsonlToParquet` gets no
 *   such treatment, and a per-country recipe output is a single-country file by construction.
 *
 *   A training epoch draws a bounded number of rows per source, and that draw reads one row-group from
 *   one file. A source whose countries sit in separate files therefore reaches only the countries of
 *   whichever file the draw lands in. Measured on `v0.6.0-register-surface`: `overture-latam` held
 *   Brazil, Mexico, Canada and the earlier Latin American mix in four files, drew 29,489 rows, and
 *   every one of them was Mexican. Brazil's receipt read 0 against a floor of 1,000.
 *
 *   Merging the files and shuffling across them puts every country of the source in every output
 *   row-group, which is what makes a per-country receipt reachable.
 */

import { mulberry32 } from "@mailwoman/core/utils"
import type { PathBuilderLike } from "path-ts"

import type { ParquetRow } from "#parquet/schema"
import { DEFAULT_SHUFFLE_SEED, DEFAULT_SHUFFLE_WINDOW, shuffleWithinWindow } from "#parquet/shuffle"
import { openParquetRowStream } from "#parquet/streams"
import { writeParquetFile } from "#parquet/writers"

export interface MergeSourceOptions {
	/**
	 * The parquet files to merge, read in the order given.
	 */
	inputs: readonly PathBuilderLike[]
	output: PathBuilderLike
	/**
	 * Rows held in memory while shuffling.
	 * Defaults to the corpus writer's own window.
	 */
	windowSize?: number
	/**
	 * Defaults to the corpus writer's seed, so a rebuild of this file reproduces it.
	 */
	seed?: number
	/**
	 * Rows per output file.
	 *
	 * `writeParquetFile` materializes one Arrow table, and Arrow's list builder overflows well
	 * before a source's whole row count: 4,228,212 rows raised where 1,603,143 wrote.
	 * The base corpus writer closes a file at `rowsPerFile` for the same reason, and this follows it.
	 *
	 * Several output files cost nothing here.
	 * What the draw needs is each row-group to mix the source's countries,
	 * and every output file is drawn from the shuffled stream.
	 */
	rowsPerFile?: number
}

/**
 * Rows per output file when the caller names none, matching the corpus writer's own default.
 */
export const DEFAULT_MERGE_ROWS_PER_FILE = 1_000_000

export interface MergeSourceResult {
	inputs: readonly string[]
	/**
	 * The files written, in order.
	 *
	 * One when the row count fits `rowsPerFile`, several otherwise.
	 */
	outputs: readonly string[]
	rows: number
	/**
	 * Rows per `country` value, so a caller can state that the merge reached the countries it meant to.
	 */
	byCountry: Record<string, number>
	/**
	 * Rows per `source` value.
	 *
	 * More than one entry means the inputs disagree about their source, which a single
	 * merged file cannot represent: the manifest records one source label per file.
	 */
	bySource: Record<string, number>
}

async function* readAll(inputs: readonly PathBuilderLike[]): AsyncGenerator<ParquetRow> {
	for (const input of inputs) {
		yield* openParquetRowStream<ParquetRow>(input)
	}
}

/**
 * Merge the inputs into one shuffled parquet file, and report what it holds.
 *
 * Raises when the inputs carry more than one `source`, because the manifest entry for the merged file
 * names a single source and a reader would then attribute rows to a source that did not produce them.
 */
export async function mergeSourceFiles(options: MergeSourceOptions): Promise<MergeSourceResult> {
	const inputs = options.inputs.map(String)
	const random = mulberry32(options.seed ?? DEFAULT_SHUFFLE_SEED)
	const rowsPerFile = options.rowsPerFile ?? DEFAULT_MERGE_ROWS_PER_FILE
	const stem = String(options.output).replace(/\.parquet$/u, "")

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
