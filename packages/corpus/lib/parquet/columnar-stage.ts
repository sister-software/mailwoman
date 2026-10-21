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
 *   string costs one. {@linkcode ColumnarStage.convert} hands each dictionary to DuckDB as a table, joins its lists
 *   to the staged rows and decodes the codes in the `COPY`, so the parquet file holds the same strings and types as
 *   {@linkcode PARQUET_COLUMN_TYPES} declares. The order of first appearance assigns the codes, and the file holds
 *   only the decoded strings, so the codes never reach the output.
 *
 *   The conversion runs at {@linkcode CONVERSION_THREADS} thread with insertion order preserved. The table scan
 *   delivers fixed 2,048-row vectors, so DuckDB closes a row group at the first vector boundary at or past
 *   {@linkcode ROW_GROUP_SIZE} rows. A file's bytes are then a function of its rows, whatever other parts the stage holds.
 */

import type { DuckDBAppender, DuckDBDataChunk, DuckDBType } from "@duckdb/node-api"
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

	#last: string | null = null
	#lastCode = -1

	code(value: string): number {
		// Consecutive rows of a part mostly repeat a categorical value, and a comparison skips the hash.
		if (value === this.#last) return this.#lastCode

		let code = this.#codes.get(value)

		if (code === undefined) {
			code = this.values.length
			this.values.push(value)
			this.#codes.set(value, code)
		}

		this.#last = value
		this.#lastCode = code

		return code
	}
}

type Bindings = typeof import("@duckdb/node-bindings")

/**
 * One column of a {@linkcode ColumnBatch}.
 *
 * A `text` column holds its strings.
 * A `code` column holds one int32 per row.
 *
 * A list column holds DuckDB's list entries (offset and length, two uint64 per row,
 * written as four uint32) over a child array of int32.
 * `invalid` marks the rows whose value is null in DuckDB's validity layout,
 * one bit per row, set when valid.
 */
interface BatchColumn {
	kind: StageKind
	dictionary: Dictionary | null
	texts: (string | null)[]
	ints: Int32Array
	entries: Uint32Array
	child: Int32Array
	childLength: number
	validity: Uint8Array
	nulls: number
}

/**
 * Rows not yet handed to DuckDB, held in the layout of a DuckDB data chunk so a flush copies
 * each column in one call, apart from the `text` columns, which take one call per string.
 */
class ColumnBatch {
	rows = 0
	readonly columns: BatchColumn[]

	constructor(dictionaries: ReadonlyMap<ParquetColumn, Dictionary>) {
		this.columns = PARQUET_COLUMNS.map((column) => ({
			kind: STAGE_KINDS[column],
			dictionary: dictionaries.get(column) ?? null,
			texts: [],
			ints: new Int32Array(STAGE_BATCH_ROWS),
			entries: new Uint32Array(STAGE_BATCH_ROWS * 4),
			child: new Int32Array(STAGE_BATCH_ROWS * 4),
			childLength: 0,
			validity: new Uint8Array(STAGE_BATCH_ROWS / 8).fill(0xff),
			nulls: 0,
		}))
	}

	add(row: ParquetRow): void {
		const index = this.rows

		for (let position = 0; position < PARQUET_COLUMNS.length; position++) {
			const column = this.columns[position]!
			const value = row[PARQUET_COLUMNS[position]!]

			if (value == null) {
				column.validity[index >> 3]! &= ~(1 << (index & 7))

				column.nulls++

				if (column.kind === "text") {
					column.texts.push(null)
				}

				// A null list is an entry of length zero at the current child length.
				column.entries[index * 4] = column.childLength

				continue
			}

			switch (column.kind) {
				case "text":
					column.texts.push(value as string)
					break
				case "code":
					column.ints[index] = column.dictionary!.code(value as string)
					break
				default: {
					const items = value as readonly (string | number)[]
					const start = column.childLength
					const end = start + items.length

					if (end > column.child.length) {
						const grown = new Int32Array(Math.max(end, column.child.length * 2))

						grown.set(column.child.subarray(0, start))
						column.child = grown
					}

					for (let item = 0; item < items.length; item++) {
						column.child[start + item] =
							column.kind === "codes"
								? column.dictionary!.code(items[item] as string)
								: int32Of(items[item], PARQUET_COLUMNS[position]!)
					}

					column.entries[index * 4] = start
					column.entries[index * 4 + 2] = items.length
					column.childLength = end
				}
			}
		}

		this.rows++
	}

	/**
	 * Write the batch into `chunk`'s vectors and empty it.
	 */
	writeTo(bindings: Bindings, chunk: import("@duckdb/node-bindings").DataChunk): void {
		const rows = this.rows

		for (const [position, column] of this.columns.entries()) {
			const vector = bindings.data_chunk_get_vector(chunk, position)

			switch (column.kind) {
				case "text":
					for (let index = 0; index < rows; index++) {
						const text = column.texts[index]

						if (text != null) {
							bindings.vector_assign_string_element(vector, index, text)
						}
					}

					column.texts = []
					break
				case "code":
					bindings.copy_data_to_vector(vector, 0, column.ints.buffer, 0, rows * 4)
					break
				default: {
					bindings.list_vector_reserve(vector, column.childLength)
					bindings.list_vector_set_size(vector, column.childLength)

					if (column.childLength) {
						bindings.copy_data_to_vector(
							bindings.list_vector_get_child(vector),
							0,
							column.child.buffer,
							0,
							column.childLength * 4
						)
					}

					bindings.copy_data_to_vector(vector, 0, column.entries.buffer, 0, rows * 16)
					column.entries.fill(0)
					column.childLength = 0
				}
			}

			if (column.nulls) {
				bindings.vector_ensure_validity_writable(vector)
				bindings.copy_data_to_vector_validity(vector, 0, column.validity.buffer, 0, Math.ceil(rows / 64) * 8)
				column.validity.fill(0xff)
				column.nulls = 0
			}
		}

		bindings.data_chunk_set_size(chunk, rows)
		this.rows = 0
	}
}

function int32Of(value: unknown, column: string): number {
	if (typeof value !== "number" || (value | 0) !== value) {
		throw new Error(`columnar stage: ${column} holds ${String(value)}, which is not an int32`)
	}

	return value
}

/**
 * The rows of one part not yet handed to DuckDB.
 */
interface StagedPart {
	table: string
	appender: DuckDBAppender
	appenderOpen: boolean
	dictionaries: Map<ParquetColumn, Dictionary>
	batch: ColumnBatch
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
	const { DuckDBDataChunk, INTEGER, LIST, VARCHAR } = await import("@duckdb/node-api")
	const { default: bindings } = await import("@duckdb/node-bindings")

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

	const appendChunk = (appender: DuckDBAppender, columns: readonly (readonly unknown[])[], types: DuckDBType[]) => {
		const rows = columns[0]!.length

		if (!rows) return

		const chunk: DuckDBDataChunk = DuckDBDataChunk.create(types, rows)

		chunk.setColumns(columns as never)
		appender.appendDataChunk(chunk)
	}

	// The appender commits when its own buffer fills and when it closes, rather than once per batch,
	// because a commit per batch cost three quarters of the writer's time on a 420,000-row fixture.
	const flush = (part: StagedPart) => {
		if (!part.batch.rows) return

		const chunk: DuckDBDataChunk = DuckDBDataChunk.create(chunkTypes)

		part.batch.writeTo(bindings, chunk.chunk)
		part.appender.appendDataChunk(chunk)
	}

	const partNamed = (name: string): StagedPart => {
		const part = parts.get(name)

		if (!part) throw new Error(`columnar stage: no open part ${name}`)

		return part
	}

	const closeAppender = (part: StagedPart) => {
		if (!part.appenderOpen) return

		part.appenderOpen = false
		part.appender.closeSync()
	}

	const dropPart = async (name: string, part: StagedPart) => {
		parts.delete(name)
		closeAppender(part)
		await db.run(`DROP TABLE IF EXISTS ${part.table}`)
		await db.run(`DROP TABLE IF EXISTS ${part.table}_dict`)
	}

	return {
		async open(name) {
			if (parts.has(name)) throw new Error(`columnar stage: part ${name} is already open`)

			const table = `part_${tables++}`

			await db.run(`CREATE TABLE ${table} (${tableDDL})`)

			const dictionaries = new Map(
				PARQUET_COLUMNS.filter((column) => STAGE_KINDS[column] === "code" || STAGE_KINDS[column] === "codes").map(
					(column) => [column, new Dictionary()]
				)
			)

			parts.set(name, {
				table,
				appender: await db.createAppender(table),
				appenderOpen: true,
				dictionaries,
				batch: new ColumnBatch(dictionaries),
				rows: 0,
			})
		},

		async append(name, row) {
			const part = partNamed(name)

			part.batch.add(row)

			part.rows++

			if (part.batch.rows >= STAGE_BATCH_ROWS) {
				flush(part)
			}
		},

		async convert(name, outputPath) {
			const part = partNamed(name)

			flush(part)
			closeAppender(part)

			// Every dictionary, one row per column and code, so each becomes one list variable.
			const dictTable = `${part.table}_dict`
			const coded = [...part.dictionaries]

			await db.run(`CREATE OR REPLACE TABLE ${dictTable} (col INTEGER, code INTEGER, value VARCHAR)`)

			const dictAppender = await db.createAppender(dictTable)
			const dictColumns: [number[], number[], string[]] = [[], [], []]
			const dictTypes = [INTEGER, INTEGER, VARCHAR]

			try {
				for (const [index, [, dictionary]] of coded.entries()) {
					for (const [code, value] of dictionary.values.entries()) {
						dictColumns[0].push(index)
						dictColumns[1].push(code)
						dictColumns[2].push(value)

						if (dictColumns[0].length >= STAGE_BATCH_ROWS) {
							appendChunk(dictAppender, dictColumns, dictTypes)
							dictColumns[0] = []
							dictColumns[1] = []
							dictColumns[2] = []
						}
					}
				}

				appendChunk(dictAppender, dictColumns, dictTypes)
			} finally {
				dictAppender.closeSync()
			}

			// One row holding every dictionary as a list, joined to each staged row.
			// A dictionary held in a session variable was read again for every list element
			// and made the conversion five times slower.
			const dictionaries = coded
				.map(
					(_, index) => `coalesce(list(value ORDER BY code) FILTER (WHERE col = ${index}), []::VARCHAR[]) AS d${index}`
				)
				.join(", ")

			const dictionaryOf = (column: ParquetColumn) =>
				`dict.d${coded.findIndex(([codedColumn]) => codedColumn === column)}`

			const selectList = PARQUET_COLUMNS.map((column) => {
				const identifier = escapeSQLIdentifier(column)

				switch (STAGE_KINDS[column]) {
					case "code":
						return `${dictionaryOf(column)}[staged.${identifier} + 1] AS ${identifier}`
					case "codes":
						return `list_transform(staged.${identifier}, code -> ${dictionaryOf(column)}[code + 1]) AS ${identifier}`
					default:
						return `staged.${identifier}`
				}
			}).join(", ")

			await db.run(
				`COPY (WITH dict AS (SELECT ${dictionaries} FROM ${dictTable}) ` +
					`SELECT ${selectList} FROM ${part.table} AS staged CROSS JOIN dict) ` +
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
			// An appender is closed before the connection it writes through.
			for (const part of parts.values()) {
				closeAppender(part)
			}

			parts.clear()
			db[Symbol.dispose]()
		},
	}
}
