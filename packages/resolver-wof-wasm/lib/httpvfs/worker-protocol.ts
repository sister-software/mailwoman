/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * The messages exchanged between `database.ts` on the page and `range-worker.ts` in its dedicated worker.
 *
 * This module exports types only. The worker script is staged and loaded by URL without a bundler, so it
 * cannot import a runtime value from a sibling module.
 */

/**
 * A value SQLite can bind to a statement parameter or return in a result column.
 */
export type SQLValue = string | number | bigint | Uint8Array | null

/**
 * Opens the database at `databaseURL` through the sqlite-wasm module at `runtimeModuleURL`.
 */
export interface OpenRequest {
	type: "open"

	/**
	 * `range` reads pages on demand through the HTTP range VFS.
	 *
	 * `whole` fetches the file once, inflates a `.gz` URL, and opens the bytes in memory.
	 * It suits a file small enough to download in one request.
	 */
	strategy: "range" | "whole"
	databaseURL: string
	runtimeModuleURL: string
	chunkSize: number
}

/**
 * Runs one statement with positional parameters and returns its rows as objects keyed by column name.
 */
export interface QueryRequest {
	type: "query"
	sql: string
	parameters: readonly SQLValue[]
}

/**
 * Reads the range-fetch counters.
 */
export interface StatsRequest {
	type: "stats"
}

export type RangeWorkerRequest = OpenRequest | QueryRequest | StatsRequest

/**
 * The counters a {@link StatsRequest} returns.
 */
export interface RangeStats {
	/**
	 * The number of HTTP range requests issued since the database opened.
	 */
	requests: number

	/**
	 * The number of response-body bytes those requests returned.
	 */
	bytes: number
}

/**
 * The result type of each request, keyed by the request's `type`.
 */
export interface RangeWorkerResults {
	open: { sqliteVersion: string }
	query: Record<string, SQLValue>[]
	stats: RangeStats
}

/**
 * A request as posted to the worker, with the identifier the worker copies into its reply.
 */
export type RangeWorkerCall = RangeWorkerRequest & { id: number }

/**
 * The worker's reply to the call with the same `id`.
 */
export type RangeWorkerReply =
	| { id: number; result: RangeWorkerResults[keyof RangeWorkerResults] }
	| { id: number; error: string }
