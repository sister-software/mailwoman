/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The DuckDB boundary for the parquet family — the one place that opens a connection and the two escapers every
 *   statement built here goes through.
 *
 *   `@duckdb/node-api` is an optional peer, so the import is lazy: the native module loads only on the paths that read
 *   or write Parquet through DuckDB. A consumer that only needs the schema types never loads it.
 */

/**
 * An open DuckDB connection, re-exported so consumers of {@link openDuckDB} can name
 * the type without their own static dependency on the optional peer.
 */
export type { DuckDBConnection } from "@duckdb/node-api"

/**
 * An in-memory DuckDB connection whose disposal also closes the instance behind it.
 *
 * Both closes are synchronous, so this is `Disposable` rather than `AsyncDisposable`,
 * the same as {@link DatabaseClient}.
 */
export type DisposableDuckDB = import("@duckdb/node-api").DuckDBConnection & Disposable

/**
 * The share of host memory one DuckDB instance may hold.
 *
 * DuckDB allocates outside the V8 heap, so `--max-old-space-size` does not bound it and a query
 * over a corpus with hundreds of millions of rows will exhaust the host rather than spill.
 * A `COUNT(DISTINCT …)` over `v0.6.0-register-surface`'s 697,675,170 train rows did
 * that twice on 2026-09-28, with a second corpus tool running beside it.
 *
 * Two instances at half the host exceed it together.
 *
 * That case took the machine down.
 * A quarter admits four concurrent instances and still leaves room for the page cache the
 * parquet reads run through and for the Node heap of each process holding a connection.
 *
 * Past its limit DuckDB spills to `temp_directory`.
 * The query finishes slower.
 * That is the failure to prefer.
 *
 * A caller that knows it holds the host by itself passes a larger `memoryLimitBytes`.
 *
 * @defaultValue a quarter because it has to bound the host rather than one query.
 */
export const DUCKDB_MEMORY_SHARE = 0.25

/**
 * Per-instance settings, applied on every connection this module opens.
 */
export interface DuckDBLimits {
	/**
	 * Bytes one instance may hold before it spills.
	 * @defaultValue {@linkcode DUCKDB_MEMORY_SHARE} of host memory.
	 */
	memoryLimitBytes?: number

	/**
	 * Worker threads.
	 *
	 * A build phase that runs DuckDB beside other work sets this, because each thread
	 * holds its own share of the memory limit and the default takes every core.
	 *
	 * @defaultValue DuckDB's own choice.
	 */
	threads?: number

	/**
	 * Where a spill is written.
	 *
	 * The default sits under the data root rather than in the system temporary directory,
	 * because a spill from a corpus-sized query is tens of gigabytes and `/tmp` is commonly a
	 * memory-backed filesystem, where spilling to it consumes the memory the spill exists to release.
	 *
	 * @defaultValue the data root's `tmp/duckdb`.
	 */
	temporaryDirectory?: string
}

/**
 * Open an in-memory DuckDB connection, taken with `using db = await openDuckDB()`.
 *
 * The connection is returned directly, so it reads as a connection at every call site.
 * Disposal closes the connection and then the instance.
 *
 * An open connection holds the native instance for the life of the process.
 * A connection opened per file in a loop holds one instance per file.
 *
 * Every connection has a memory limit.
 * It is set here rather than at each call site because host memory exhaustion affects
 * every process, including processes unrelated to the query that caused it.
 */
export async function openDuckDB(limits: DuckDBLimits = {}): Promise<DisposableDuckDB> {
	const { DuckDBInstance } = await import("@duckdb/node-api")
	const { dataRootPath } = await import("@mailwoman/core/data-root")
	const { ByteFormatter } = await import("@mailwoman/core/fs/formatters")
	const { makeDirectories } = await import("@mailwoman/core/fs/writers")
	const { totalMemoryBytes } = await import("@mailwoman/core/utils/system")

	const memoryLimitBytes = limits.memoryLimitBytes ?? Math.floor(totalMemoryBytes() * DUCKDB_MEMORY_SHARE)
	const temporaryDirectory = limits.temporaryDirectory ?? dataRootPath("tmp", "duckdb").toString()

	// DuckDB writes a spill file rather than creating the directory, so a missing
	// one turns a spill into a failed query.
	// Created here, where the default is chosen.
	await makeDirectories(temporaryDirectory)

	const instance = await DuckDBInstance.create(":memory:", {
		// DuckDB parses the value, so it takes a string with a unit rather than a byte count.
		// `formatIEC` writes the binary unit DuckDB reads back verbatim; `formatSI`'s `MB`
		// would be read as decimal megabytes and set a limit 4.9% under the one this asked for.
		memory_limit: ByteFormatter.formatIEC(memoryLimitBytes),
		temp_directory: temporaryDirectory,
		...(limits.threads ? { threads: String(limits.threads) } : {}),
	})

	const connection = await instance.connect()

	return Object.assign(connection, {
		[Symbol.dispose]: () => {
			connection.closeSync()
			instance.closeSync()
		},
	})
}

/**
 * Escape `value` for a single-quoted SQL string literal.
 *
 * The caller supplies the quotes.
 */
export function escapeSQLString(value: string): string {
	return value.replaceAll("'", "''")
}

/**
 * Escape `value` as a double-quoted SQL identifier, for a column name that reaches a statement from data.
 *
 * A projection names columns the caller chose, so the name is not a literal this module wrote.
 * Quotes preserve a column whose name collides with a keyword — or includes a space —
 * from re-parsing as syntax.
 */
export function escapeSQLIdentifier(value: string): string {
	return `"${value.replaceAll('"', '""')}"`
}
