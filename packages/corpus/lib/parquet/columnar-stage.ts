/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Stages parquet parts as DuckDB tables filled from bounded columnar batches, then converts each part to a
 *   parquet file.
 *
 *   {@linkcode openColumnarStage} opens one file-backed DuckDB database in a staging directory. Each open part is a
 *   table in it. Rows are buffered column by column, {@linkcode STAGE_BATCH_ROWS} at a time, and each full batch
 *   goes to DuckDB as one data chunk through an appender, so the JavaScript side holds at most one batch per open
 *   part and DuckDB holds the rest within its memory limit, spilling to the database file.
 *
 *   A string column whose values repeat (tokens, labels, span tags, country, license and the other categorical
 *   columns) is staged as integer codes into a per-part dictionary, because a code costs no call into DuckDB and a
 *   string costs one. {@linkcode ColumnarStage.convert} hands each dictionary to DuckDB as a list variable and
 *   decodes the codes in the `COPY`, so the parquet file holds the same strings and types as
 *   {@linkcode PARQUET_COLUMN_TYPES} declares. The order of first appearance assigns the codes, and the file holds
 *   only the decoded strings, so the codes never reach the output.
 *
 *   The conversion runs at {@linkcode CONVERSION_THREADS} thread with insertion order preserved. The table scan
 *   delivers fixed 2,048-row vectors, so DuckDB closes a row group at the first vector boundary at or past
 *   {@linkcode ROW_GROUP_SIZE} rows. A file's bytes are then a function of its rows, whatever other parts the stage holds.
 */

import type { DuckDBAppender, DuckDBDataChunk, DuckDBListValue, DuckDBType } from "@duckdb/node-api"
import { tryStat } from "@mailwoman/core/fs/readers/stat"

import {
	type DisposableDuckDB,
	type DuckDBLimits,
	escapeSQLIdentifier,
	escapeSQLString,
	openDuckDB,
} from "#parquet/duckdb"
import { PARQUET_COLUMNS, type ParquetRow, ROW_GROUP_SIZE } from "#parquet/schema"

/**
 * DuckDB threads for converting a staged part, whatever the instance's own limit.
 *
 * The row-group boundaries of a multi-threaded `COPY` move between runs: measured 2026-10-20
 * on one 1,000,000-row `ban` part, three conversions each at 2, 4 and 16 threads wrote
 * two different files at every count, and 1 thread wrote one file every time.
 * One thread makes a file's bytes a function of its rows.
 */
export const CONVERSION_THREADS = 1

/**
 * Rows per data chunk handed to DuckDB, DuckDB's standard vector size and the largest chunk it accepts.
 */
export const STAGE_BATCH_ROWS = 2048

type ParquetColumn = (typeof PARQUET_COLUMNS)[number]

/**
 * How a parquet column is staged.
 *
 * - `text`: a VARCHAR whose values rarely repeat, staged as itself.
 * - `code`: a VARCHAR staged as an integer code into the part's dictionary.
 * - `codes`: a VARCHAR[] staged as a list of codes.
 * - `ints`: an INTEGER[] staged as itself.
 */
type StageKind = "text" | "code" | "codes" | "ints"

/**
 * Each column's staging, in {@linkcode PARQUET_COLUMNS} order.
 */
const STAGE_KINDS: Record<ParquetColumn, StageKind> = {
	raw: "text",
	tokens: "codes",
	labels: "codes",
	span_starts: "ints",
	span_ends: "ints",
	span_tags: "codes",
	country: "code",
	locale: "code",
	source: "code",
	source_id: "text",
	license: "code",
	register: "code",
	surface: "code",
	augmentation: "code",
	base_source_id: "text",
}

const STAGE_SQL_TYPES: Record<StageKind, string> = {
	text: "VARCHAR",
	code: "INTEGER",
	codes: "INTEGER[]",
	ints: "INTEGER[]",
}

/**
 * The dictionary of one coded column of one part.
 */
class Dictionary {
	readonly values: string[] = []
	readonly #codes = new Map<string, number>()

	code(value: string): number {
		let code = this.#codes.get(value)

		if (code === undefined) {
			code = this.values.length
			this.values.push(value)
			this.#codes.set(value, code)
		}

		return code
	}
}

/**
 * The rows of one part not yet handed to DuckDB, one array per column.
 */
interface StagedPart {
	table: string
	dictionaries: Map<ParquetColumn, Dictionary>
	batch: unknown[][]
	batchRows: number
	rows: number
}

/**
 * A staging database holding one table per open part.
 */
export interface ColumnarStage extends Disposable {
	/**
	 * Start the part `name`, which no open part of this stage may already use.
	 */
	open(name: string): Promise<void>

	/**
	 * Add one row to the part `name`.
	 *
	 * It is synchronous until a batch fills, when the batch goes to DuckDB.
	 */
	append(name: string, row: ParquetRow): Promise<void>

	/**
	 * Write the part `name` to a parquet file at `outputPath` and drop its table.
	 *
	 * A failed conversion keeps the table, so the rows stay staged until the stage is disposed.
	 */
	convert(name: string, outputPath: string): Promise<void>

	/**
	 * Drop the part `name` without writing it.
	 */
	discard(name: string): Promise<void>

	/**
	 * Bytes the staging database and its write-ahead log hold on disk now.
	 */
	diskBytes(): Promise<number>
}

/**
 * Open a staging database at `databasePath`, which must not exist yet.
 *
 * The instance runs at {@linkcode CONVERSION_THREADS} threads and the memory limit `limits` gives.
 */
export async function openColumnarStage(databasePath: string, limits: DuckDBLimits = {}): Promise<ColumnarStage> {
	const { DuckDBDataChunk, INTEGER, LIST, VARCHAR, listValue } = await import("@duckdb/node-api")

	const db: DisposableDuckDB = await openDuckDB({ ...limits, threads: CONVERSION_THREADS }, databasePath)

	await db.run("SET preserve_insertion_order=true")
	await db.run(`SET threads=${CONVERSION_THREADS}`)

	const kinds = PARQUET_COLUMNS.map((column) => STAGE_KINDS[column])
	const intList = LIST(INTEGER)

	const chunkTypes: DuckDBType[] = kinds.map((kind) => {
		if (kind === "text") return VARCHAR

		if (kind === "code") return INTEGER

		return intList
	})

	const tableDDL = PARQUET_COLUMNS.map(
		(column) => `${escapeSQLIdentifier(column)} ${STAGE_SQL_TYPES[STAGE_KINDS[column]]}`
	).join(", ")

	const parts = new Map<string, StagedPart>()
	let tables = 0

	const emptyBatch = (): unknown[][] => PARQUET_COLUMNS.map(() => [])

	const appendChunk = async (table: string, columns: readonly (readonly unknown[])[], types: DuckDBType[]) => {
		const rows = columns[0]!.length

		if (!rows) return

		const appender: DuckDBAppender = await db.createAppender(table)

		try {
			const chunk: DuckDBDataChunk = DuckDBDataChunk.create(types, rows)

			chunk.setColumns(columns as never)
			appender.appendDataChunk(chunk)
			appender.flushSync()
		} finally {
			appender.closeSync()
		}
	}

	const flush = async (part: StagedPart) => {
		await appendChunk(part.table, part.batch, chunkTypes)
		part.batch = emptyBatch()
		part.batchRows = 0
	}

	const partNamed = (name: string): StagedPart => {
		const part = parts.get(name)

		if (!part) throw new Error(`columnar stage: no open part ${name}`)

		return part
	}

	const dropPart = async (name: string, part: StagedPart) => {
		parts.delete(name)
		await db.run(`DROP TABLE IF EXISTS ${part.table}`)
		await db.run(`DROP TABLE IF EXISTS ${part.table}_dict`)
	}

	return {
		async open(name) {
			if (parts.has(name)) throw new Error(`columnar stage: part ${name} is already open`)

			const table = `part_${tables++}`

			await db.run(`CREATE TABLE ${table} (${tableDDL})`)

			parts.set(name, {
				table,
				dictionaries: new Map(
					PARQUET_COLUMNS.filter((column) => STAGE_KINDS[column] === "code" || STAGE_KINDS[column] === "codes").map(
						(column) => [column, new Dictionary()]
					)
				),
				batch: emptyBatch(),
				batchRows: 0,
				rows: 0,
			})
		},

		async append(name, row) {
			const part = partNamed(name)

			for (let index = 0; index < PARQUET_COLUMNS.length; index++) {
				const column = PARQUET_COLUMNS[index]!
				const value = row[column]
				let staged: unknown

				switch (kinds[index]) {
					case "text":
						staged = typeof value === "string" ? value : null
						break
					case "code":
						staged = typeof value === "string" ? part.dictionaries.get(column)!.code(value) : null
						break
					case "codes": {
						const dictionary = part.dictionaries.get(column)!

						staged = Array.isArray(value)
							? listValue((value as readonly string[]).map((item) => dictionary.code(item)))
							: null

						break
					}
					case "ints":
						staged = Array.isArray(value) ? (listValue(value as readonly number[]) as DuckDBListValue) : null
						break
				}

				part.batch[index]!.push(staged)
			}

			part.rows++

			if (++part.batchRows >= STAGE_BATCH_ROWS) {
				await flush(part)
			}
		},

		async convert(name, outputPath) {
			const part = partNamed(name)

			await flush(part)

			// Every dictionary, one row per column and code, so each becomes one list variable.
			const dictTable = `${part.table}_dict`
			const coded = [...part.dictionaries]

			await db.run(`CREATE OR REPLACE TABLE ${dictTable} (col INTEGER, code INTEGER, value VARCHAR)`)

			const dictColumns: [number[], number[], string[]] = [[], [], []]
			const dictTypes = [INTEGER, INTEGER, VARCHAR]

			for (const [index, [, dictionary]] of coded.entries()) {
				for (const [code, value] of dictionary.values.entries()) {
					dictColumns[0].push(index)
					dictColumns[1].push(code)
					dictColumns[2].push(value)

					if (dictColumns[0].length >= STAGE_BATCH_ROWS) {
						await appendChunk(dictTable, dictColumns, dictTypes)
						dictColumns[0] = []
						dictColumns[1] = []
						dictColumns[2] = []
					}
				}
			}

			await appendChunk(dictTable, dictColumns, dictTypes)

			for (const [index] of coded.entries()) {
				await db.run(
					`SET VARIABLE mw_dict_${index} = ` +
						`(SELECT coalesce(list(value ORDER BY code), []::VARCHAR[]) FROM ${dictTable} WHERE col = ${index})`
				)
			}

			const variable = (column: ParquetColumn) =>
				`getvariable('mw_dict_${coded.findIndex(([codedColumn]) => codedColumn === column)}')`

			const selectList = PARQUET_COLUMNS.map((column) => {
				const identifier = escapeSQLIdentifier(column)

				switch (STAGE_KINDS[column]) {
					case "code":
						return `${variable(column)}[${identifier} + 1] AS ${identifier}`
					case "codes":
						return `list_transform(${identifier}, code -> ${variable(column)}[code + 1]) AS ${identifier}`
					default:
						return identifier
				}
			}).join(", ")

			await db.run(
				`COPY (SELECT ${selectList} FROM ${part.table}) ` +
					`TO '${escapeSQLString(outputPath)}' (FORMAT PARQUET, COMPRESSION SNAPPY, ROW_GROUP_SIZE ${ROW_GROUP_SIZE})`
			)

			await dropPart(name, part)
			// Returns the dropped part's blocks to the database file's free list, so the next parts reuse them.
			await db.run("CHECKPOINT")
		},

		async discard(name) {
			await dropPart(name, partNamed(name))
		},

		async diskBytes() {
			const [database, wal] = await Promise.all([tryStat(databasePath), tryStat(`${databasePath}.wal`)])

			return (database?.size ?? 0) + (wal?.size ?? 0)
		},

		[Symbol.dispose]() {
			parts.clear()
			db[Symbol.dispose]()
		},
	}
}
