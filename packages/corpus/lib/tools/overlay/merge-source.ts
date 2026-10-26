/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Merges one source's overlay parquet files into shuffled output files.
 *
 *   The training sampler can read a whole per-source draw from one row group,
 *   so a source split into per-country files would reach only one country per draw.
 *   A shuffle across the inputs mixes each source's countries within each row group.
 */

import { sha256File, sha256Hex } from "@mailwoman/core/hash"
import { mulberry32 } from "@mailwoman/core/utils"
import type { PathBuilderLike } from "path-ts"

import { moduleGraphHash } from "#build/code-hash"
import { openCorpusRowStream } from "#parquet/corpus-rows"
import { escapeSQLString, openDuckDB } from "#parquet/duckdb"
import { corpusRowFromParquet, type ParquetRow, ROWS_PER_FILE } from "#parquet/schema"
import { DEFAULT_SHUFFLE_SEED, DEFAULT_SHUFFLE_WINDOW, shuffleWithinWindow } from "#parquet/shuffle"
import { openParquetRowStream, readParquetSQL } from "#parquet/streams"
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
	 * The output path.
	 * Each written file receives a five-digit index in its stem.
	 */
	output: PathBuilderLike
	/**
	 * The number of rows held in memory while shuffling.
	 *
	 * @defaultValue the corpus writer's window.
	 */
	windowSize?: number
	/**
	 * Keep at most this many rows of each country, chosen by a hash of each row's `source_id`,
	 * and write the kept rows of every input in one hash order rather than through the window.
	 *
	 * A build writes a source's rows in record order, so the 250,000-row window mixes a few thousand
	 * neighboring records, and a training draw that reads one row group sees one stretch of one country.
	 * The hash order makes every row group a sample of the whole selection.
	 */
	rowsPerCountry?: number
	/**
	 * The shuffle seed.
	 *
	 * The default matches the corpus writer's seed.
	 * This makes rebuilds reproducible.
	 */
	seed?: number
	/**
	 * The maximum rows per output file.
	 *
	 * `writeParquetFile` builds one Arrow table per file.
	 * Arrow's list builder overflows on very large tables.
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
	 * Row counts per `source` value.
	 * A successful merge has one entry.
	 */
	bySource: Record<string, number>
}

async function* readAll(inputs: readonly PathBuilderLike[]): AsyncGenerator<ParquetRow> {
	for (const input of inputs) {
		yield* openCorpusRowStream(input)
	}
}

async function countRowsByCountry(
	inputs: readonly PathBuilderLike[]
): Promise<Array<{ country: string; rows: number }>> {
	using db = await openDuckDB()

	const result = await db.runAndReadAll(
		`SELECT country, count(*) AS rows FROM ${readParquetSQL(inputs)} GROUP BY country`
	)

	return (result.getRowObjects() as Array<{ country: unknown; rows: unknown }>).map((row) => ({
		country: String(row.country),
		rows: Number(row.rows),
	}))
}

/**
 * The hash buckets a row's `source_id` falls in, for choosing a fraction of a country's rows.
 */
const SAMPLE_BUCKETS = 1_000_000

/**
 * Reads at most `rowsPerCountry` rows of each country across every input, in an order set by `seed`.
 *
 * A country with more rows keeps the rows whose `source_id` hashes into its share
 * of the buckets, so it keeps about `rowsPerCountry` of them.
 */
async function* readSample(
	inputs: readonly PathBuilderLike[],
	rowsPerCountry: number,
	seed: number
): AsyncGenerator<ParquetRow> {
	const counts = await countRowsByCountry(inputs)

	const kept = counts
		.filter(({ rows }) => rows > rowsPerCountry)
		.map(({ country, rows }) => {
			const buckets = Math.ceil((rowsPerCountry / rows) * SAMPLE_BUCKETS)

			return `WHEN '${escapeSQLString(country)}' THEN hash(source_id || '${seed}') % ${SAMPLE_BUCKETS} < ${buckets}`
		})

	const where = kept.length ? `CASE country ${kept.join(" ")} ELSE true END` : undefined

	for await (const raw of openParquetRowStream<Record<string, unknown>>(inputs, {
		where,
		orderBy: `hash(source_id || '${seed + 1}')`,
	})) {
		yield corpusRowFromParquet(raw)
	}
}

/**
 * Merges the inputs through a windowed shuffle into one or more parquet files and reports their contents.
 *
 * Each written file gets a record beside it, whose extract hash covers every input's sha256 in order.
 *
 * @throws When the inputs contain more than one `source`, because a manifest
 * entry records one source per file.
 * An output file that would mix sources is refused when it is written.
 * A file flushed before the second source arrived remains on disk.
 */
export async function mergeSourceFiles(options: MergeSourceOptions): Promise<MergeSourceResult> {
	const inputs = options.inputs.map((input) => input.toString())
	const rowsPerFile = options.rowsPerFile ?? ROWS_PER_FILE
	const stem = options.output.toString().replace(/\.parquet$/u, "")
	const windowSize = options.windowSize ?? DEFAULT_SHUFFLE_WINDOW
	const seed = options.seed ?? DEFAULT_SHUFFLE_SEED
	const random = mulberry32(seed)
	const inputDigests: string[] = []

	for (const input of inputs) {
		inputDigests.push(await sha256File(input))
	}

	const extractHash = sha256Hex(inputDigests.join("\n"))
	const codeHash = await moduleGraphHash([import.meta.filename])

	const byCountry: Record<string, number> = {}
	const bySource: Record<string, number> = {}
	const outputs: string[] = []
	let pending: ParquetRow[] = []
	let rows = 0

	const flush = async (): Promise<void> => {
		if (!pending.length) return

		const output = `${stem}-${String(outputs.length).padStart(5, "0")}.parquet`

		await writeParquetFile(pending, output, {
			extractHash,
			codeHash,
			config: {
				tool: "merge-source",
				seed,
				windowSize,
				rowsPerCountry: options.rowsPerCountry ?? null,
				rowsPerFile,
				part: outputs.length,
			},
		})

		outputs.push(output)
		pending = []
	}

	const ordered =
		typeof options.rowsPerCountry === "number"
			? readSample(options.inputs, options.rowsPerCountry, seed)
			: shuffleWithinWindow(readAll(options.inputs), random, windowSize)

	for await (const row of ordered) {
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
