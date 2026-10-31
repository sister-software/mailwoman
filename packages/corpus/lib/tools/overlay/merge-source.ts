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
import { mergeInputCheckouts, readParquetRecord } from "#parquet/record"
import { corpusRowFromParquet, type ParquetRow, ROWS_PER_FILE } from "#parquet/schema"
import { DEFAULT_SHUFFLE_SEED, DEFAULT_SHUFFLE_WINDOW, shuffleWithinWindow } from "#parquet/shuffle"
import { openParquetRowStream, readParquetSQL } from "#parquet/streams"
import { writeParquetFile } from "#parquet/writers"
import { wofNameSlotSQL } from "#utils/wof-json"

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
	 * Keep at most `rowsPerCountry` rows of each country, chosen by a hash of each row's `source_id`,
	 * and write the kept rows of every input in one hash order rather than through the window.
	 *
	 * A build writes a source's rows in record order, so the 250,000-row window mixes a few thousand
	 * neighboring records, and a training draw that reads one row group sees one stretch of one country.
	 * The hash order makes every row group a sample of the whole selection.
	 */
	rowsPerCountry?: number
	/**
	 * Keep the first rows of every cell before the per-country fill, so a rare structure
	 * reaches the sample regardless of the row count for its country.
	 *
	 * With a floor, `rowsPerCountry` is exact: each country keeps its floor rows,
	 * then the rest of its rows in hash order up to `rowsPerCountry`.
	 * Without `rowsPerCountry`, each country keeps only its floor rows.
	 */
	cellFloor?: CellFloor
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
 * The rows every cell keeps in a {@link mergeSourceFiles} sample.
 */
export interface CellFloor {
	/**
	 * Rows each cell keeps, chosen in hash order.
	 * A cell with fewer rows keeps them all.
	 */
	rows: number
	/**
	 * SQL expressions over a row's columns.
	 *
	 * Each one splits every country's rows into cells, and a row is kept
	 * when it is among the first `rows` of any of its cells.
	 */
	keys: readonly string[]
}

/**
 * The components a row's `B-` labels open, in order, such as `locality region country`.
 *
 * The order represents the rendered record's placetype, its neighboring levels and their order.
 */
export const LABEL_ORDER_SQL = `array_to_string(list_transform(list_filter(labels, x -> x LIKE 'B-%'), x -> substr(x, 3)), ' ')`

const STRUCTURE_SQL = `${LABEL_ORDER_SQL} || '|' || coalesce(augmentation, '')`
const WOF_SLOT = wofNameSlotSQL()

/**
 * The cell keys a {@link CellFloor} can reference.
 *
 * `structure` is the label order and the surface augmentation, for any source.
 * `wof-name-slot` adds the WOF name slot's kind to that structure,
 * and keys a second cell by the slot's language.
 */
export const CELL_KEYS = {
	structure: [STRUCTURE_SQL],
	"wof-name-slot": [`${STRUCTURE_SQL} || '|' || ${WOF_SLOT.kind}`, WOF_SLOT.language],
} as const satisfies Record<string, readonly string[]>

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

	yield* readInOrder(inputs, where, seed)
}

/**
 * The `source_id` values a {@link CellFloor} sample keeps, as a subquery over the inputs.
 *
 * Within each country a row is a floor row when it is among the first `floor.rows`
 * of any of its cells in hash order.
 * The country then keeps its floor rows and, in hash order, its other rows until it holds `fill` rows.
 */
export function cellFloorSQL(inputs: readonly PathBuilderLike[], floor: CellFloor, fill: number, seed: number): string {
	if (!floor.keys.length) throw new Error("a cell floor needs at least one cell key")

	const hash = `hash(source_id || '${seed}')`
	const ranks = floor.keys.map((key, i) => `row_number() OVER (PARTITION BY country, ${key} ORDER BY ${hash}) AS r${i}`)
	const inFloor = floor.keys.map((_, i) => `r${i} <= ${floor.rows}`).join(" OR ")

	return (
		`SELECT source_id FROM (` +
		`SELECT source_id, is_floor, row_number() OVER (PARTITION BY country ORDER BY is_floor DESC, h) AS country_rank FROM (` +
		`SELECT source_id, country, h, (${inFloor}) AS is_floor FROM (` +
		`SELECT source_id, country, ${hash} AS h, ${ranks.join(", ")} FROM ${readParquetSQL(inputs)}))) ` +
		`WHERE is_floor OR country_rank <= ${fill}`
	)
}

async function* readFloorSample(
	inputs: readonly PathBuilderLike[],
	floor: CellFloor,
	fill: number,
	seed: number
): AsyncGenerator<ParquetRow> {
	yield* readInOrder(inputs, `source_id IN (${cellFloorSQL(inputs, floor, fill, seed)})`, seed)
}

async function* readInOrder(
	inputs: readonly PathBuilderLike[],
	where: string | undefined,
	seed: number
): AsyncGenerator<ParquetRow> {
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
 * Each written file gets a record beside it.
 * Its extract hash covers every input's sha256 in order.
 *
 * The record keeps the checkout commits shared by its inputs' records.
 * It records none when any input lacks them.
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
	const records = await Promise.all(inputs.map((input) => readParquetRecord(input)))
	const checkouts = mergeInputCheckouts(records.map((record) => record?.derivation ?? null))

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
				cellFloor: options.cellFloor ?? null,
				rowsPerFile,
				part: outputs.length,
			},
			...checkouts,
		})

		outputs.push(output)
		pending = []
	}

	const ordered = options.cellFloor
		? readFloorSample(options.inputs, options.cellFloor, options.rowsPerCountry ?? 0, seed)
		: typeof options.rowsPerCountry === "number"
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
