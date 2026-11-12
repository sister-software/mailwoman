// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * The page's handle on a remote SQLite database read by HTTP range requests.
 *
 * `openRangeDatabase` starts the worker in `range-worker.ts`, which runs
 * `@sqlite.org/sqlite-wasm` over a read-only VFS.
 * The browser lookups in this directory take the {@link RangeDatabase} it returns.
 */

import type {
	RangeStats,
	RangeWorkerCall,
	RangeWorkerReply,
	RangeWorkerRequest,
	RangeWorkerResults,
	SQLValue,
} from "#httpvfs/worker-protocol"

/**
 * A read-only SQLite database whose statements run in a worker.
 */
export interface RangeDatabase {
	/**
	 * Runs one statement with positional `?` parameters and returns its rows keyed by column name.
	 */
	query<Row = Record<string, SQLValue>>(sql: string, parameters?: readonly SQLValue[]): Promise<Row[]>

	/**
	 * Returns the total bytes range-fetched from the database so far.
	 */
	bytesRead(): Promise<number>

	/**
	 * Ends the worker that holds the database, freeing its sqlite-wasm heap and its chunk cache.
	 *
	 * Every later call rejects.
	 * A database read without a worker, such as a server's or a test's, omits it.
	 */
	close?(): void
}

/**
 * Tunes how {@link openRangeDatabase} fetches the file.
 */
export interface RangeDatabaseOptions {
	/**
	 * The bytes per HTTP range request, defaulting to {@link DEFAULT_CHUNK_SIZE}.
	 *
	 * Each request waits for the previous one, so a larger chunk lowers latency by
	 * saving round trips and a smaller chunk lowers the bytes fetched.
	 */
	chunkSize?: number

	/**
	 * The most chunk bytes the worker keeps in memory, defaulting to {@link DEFAULT_CHUNK_CACHE_BYTES}.
	 *
	 * Past the bound the worker drops the least recently read chunk, and a later read of
	 * it is fetched again, from the service worker's cache when one stored it.
	 */
	chunkCacheBytes?: number
}

/**
 * The default bound on the chunk bytes a range worker keeps in memory:
 * 1,024 chunks of {@link DEFAULT_CHUNK_SIZE}.
 *
 * Without a bound each worker keeps every chunk it has read for the life of the page.
 */
export const DEFAULT_CHUNK_CACHE_BYTES = 64 * 1024 * 1024

/**
 * The default bytes per range request, eight 8 KiB SQLite pages.
 *
 * On 16 cold name probes of the candidate table a 64 KiB chunk issued 55 requests
 * and an 8 KiB chunk issued 84.
 */
export const DEFAULT_CHUNK_SIZE = 65_536

/**
 * SQLite's primary result code for an I/O error.
 *
 * The low byte of an extended code holds the primary code, so `SQLITE_IOERR_READ` (266) reads as 10.
 */
const SQLITE_IOERR = 10

/**
 * A statement the range worker couldn't run, with SQLite's extended result code
 * when SQLite raised the failure.
 */
export class RangeWorkerError extends Error {
	readonly resultCode: number | null

	constructor(message: string, resultCode: number | null) {
		super(message)
		this.name = "RangeWorkerError"
		this.resultCode = resultCode
	}
}

/**
 * Whether a range-database failure is a page read SQLite couldn't complete, as when a range request fails.
 *
 * In a page under a caching service worker that's offline, it means the pages
 * a query needs were never cached.
 */
export function isSQLiteReadFailure(error: unknown): boolean {
	return error instanceof RangeWorkerError && error.resultCode != null && (error.resultCode & 0xff) === SQLITE_IOERR
}

/**
 * The file name of the compiled worker script under the runtime base URL,
 * as `stageSQLiteRuntimeAssets` writes it.
 */
export const RANGE_WORKER_FILE = "range-worker.js"

/**
 * The file name of the sqlite-wasm entry module under the runtime base URL,
 * as `@sqlite.org/sqlite-wasm` ships it.
 */
export const SQLITE_RUNTIME_MODULE_FILE = "index.mjs"

/**
 * The range workers this page has open, so a memory readout can ask each for its cache.
 */
const liveClients = new Set<RangeWorkerClient>()

/**
 * The range workers open in this page, and the bytes their chunk caches hold.
 *
 * A worker that fails to answer is counted in `workers` and left out of `cachedBytes`,
 * and `unanswered` counts it, so a partial sum doesn't read as a complete one.
 */
export async function rangeWorkerMemory(): Promise<{ workers: number; cachedBytes: number; unanswered: number }> {
	const clients = [...liveClients]
	const replies = await Promise.allSettled(clients.map((client) => client.call({ type: "stats" })))
	let cachedBytes = 0
	let unanswered = 0

	for (const reply of replies) {
		if (reply.status === "fulfilled") {
			cachedBytes += reply.value.cachedBytes
		} else {
			unanswered++
		}
	}

	return { workers: clients.length, cachedBytes, unanswered }
}

class RangeWorkerClient implements RangeDatabase {
	readonly #worker: Worker
	readonly #pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
	#nextID = 0
	/**
	 * The error from the worker's `error` event.
	 *
	 * The worker answers each call's own failure with a reply, so this event means the
	 * worker itself failed and its database state is unknown.
	 * Every later call rejects with this error.
	 */
	#failure: Error | null = null

	constructor(workerURL: string) {
		this.#worker = new Worker(workerURL, { type: "module" })
		liveClients.add(this)

		this.#worker.addEventListener("message", (event: MessageEvent<RangeWorkerReply>) => {
			const reply = event.data
			const waiter = this.#pending.get(reply.id)

			if (!waiter) return

			this.#pending.delete(reply.id)

			if ("error" in reply) {
				waiter.reject(new RangeWorkerError(reply.error, reply.resultCode))
			} else {
				waiter.resolve(reply.result)
			}
		})

		this.#worker.addEventListener("error", (event) => {
			const error = new Error(event.message || `The range worker at ${workerURL} failed to load`)

			this.#failure = error

			for (const waiter of this.#pending.values()) {
				waiter.reject(error)
			}

			this.#pending.clear()
		})
	}

	call<Request extends RangeWorkerRequest>(request: Request): Promise<RangeWorkerResults[Request["type"]]> {
		const reply = new Promise<unknown>((resolve, reject) => {
			if (this.#failure) {
				reject(this.#failure)

				return
			}

			const id = this.#nextID++

			this.#pending.set(id, { resolve, reject })
			this.#worker.postMessage({ ...request, id } satisfies RangeWorkerCall)
		})

		// The worker answers each request type with that type's result.
		return reply as Promise<RangeWorkerResults[Request["type"]]>
	}

	query<Row = Record<string, SQLValue>>(sql: string, parameters: readonly SQLValue[] = []): Promise<Row[]> {
		return this.call({ type: "query", sql, parameters }) as Promise<Row[]>
	}

	async bytesRead(): Promise<number> {
		const stats: RangeStats = await this.call({ type: "stats" })

		return stats.bytes
	}

	terminate(): void {
		liveClients.delete(this)
		this.#worker.terminate()
	}

	close(): void {
		const error = new Error("The range database is closed")

		liveClients.delete(this)
		this.#failure ??= error
		this.#worker.terminate()

		for (const waiter of this.#pending.values()) {
			waiter.reject(error)
		}

		this.#pending.clear()
	}
}

function runtimeBase(runtimeBaseURL: string): URL {
	return new URL(runtimeBaseURL.endsWith("/") ? runtimeBaseURL : `${runtimeBaseURL}/`, globalThis.location.href)
}

/**
 * Opens the SQLite database at `databaseURL` by fetching the whole file into memory.
 *
 * A URL ending in `.gz` is inflated in the worker.
 * Use this for a file small enough to download in one request, such as the docs
 * search index; `openRangeDatabase` suits a file read in pieces.
 */
export async function openWholeDatabase(databaseURL: string, runtimeBaseURL: string): Promise<RangeDatabase> {
	const base = runtimeBase(runtimeBaseURL)
	const client = new RangeWorkerClient(new URL(RANGE_WORKER_FILE, base).href)

	try {
		await client.call({
			type: "open",
			strategy: "whole",
			databaseURL: new URL(databaseURL, globalThis.location.href).href,
			runtimeModuleURL: new URL(SQLITE_RUNTIME_MODULE_FILE, base).href,
			chunkSize: 0,
			chunkCacheBytes: 0,
		})

		await client.query("SELECT count(*) FROM sqlite_master")

		return client
	} catch (error) {
		client.terminate()
		throw error
	}
}

/**
 * Whether an open failed in a way a fresh, uncached read can fix.
 *
 * - SQLite reports a malformed database: a stale cached response can serve bytes from an older file.
 * - The first range read returned HTTP 200 or 502: a cache answered with the whole file,
 *   or the service worker refused such an answer.
 * - The first range read returned fewer bytes than it asked for: a torn body.
 */
function isRetriableOpenFailure(error: unknown): boolean {
	return /malformed|not a database|disk image|returned HTTP (?:200|502)\b|bytes, expected/i.test(String(error))
}

/**
 * Opens the SQLite database at `databaseURL` for range-request reads.
 *
 * `runtimeBaseURL` is the same-origin directory where the host staged the worker script
 * and the sqlite-wasm runtime.
 *
 * If the first open fails in a way {@link isRetriableOpenFailure} recognizes,
 * it retries once with a cache-busting query string.
 */
export async function openRangeDatabase(
	databaseURL: string,
	runtimeBaseURL: string,
	options: RangeDatabaseOptions = {}
): Promise<RangeDatabase> {
	const base = runtimeBase(runtimeBaseURL)

	const open = async (url: string): Promise<RangeDatabase> => {
		const client = new RangeWorkerClient(new URL(RANGE_WORKER_FILE, base).href)

		try {
			await client.call({
				type: "open",
				strategy: "range",
				databaseURL: new URL(url, globalThis.location.href).href,
				runtimeModuleURL: new URL(SQLITE_RUNTIME_MODULE_FILE, base).href,
				chunkSize: options.chunkSize ?? DEFAULT_CHUNK_SIZE,
				chunkCacheBytes: options.chunkCacheBytes ?? DEFAULT_CHUNK_CACHE_BYTES,
			})

			await client.query("SELECT count(*) FROM sqlite_master")

			return client
		} catch (error) {
			client.terminate()
			throw error
		}
	}

	try {
		return await open(databaseURL)
	} catch (error) {
		if (!isRetriableOpenFailure(error)) throw error

		const separator = databaseURL.includes("?") ? "&" : "?"

		return open(`${databaseURL}${separator}cb=${Date.now()}`)
	}
}

/**
 * Reports whether the database contains the table `name`, in one query.
 */
export async function tableExists(database: RangeDatabase, name: string): Promise<boolean> {
	const rows = await database.query<{ n: number }>(
		"SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?",
		[name]
	)

	return Number(rows[0]?.n ?? 0) > 0
}
