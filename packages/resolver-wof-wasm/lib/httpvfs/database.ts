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
 *
 * `restarts` counts the workers this page has replaced after a failure.
 */
export async function rangeWorkerMemory(): Promise<{
	workers: number
	cachedBytes: number
	unanswered: number
	restarts: number
}> {
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

	return { workers: clients.length, cachedBytes, unanswered, restarts: workerRestarts }
}

/**
 * The most times a range worker is replaced inside {@link RANGE_WORKER_RESTART_WINDOW_MS}.
 *
 * It is a starting value with no measurement behind it.
 *
 * @public
 */
export const RANGE_WORKER_RESTART_LIMIT = 3

/**
 * The span over which {@link RANGE_WORKER_RESTART_LIMIT} counts replacements.
 *
 * @public
 */
export const RANGE_WORKER_RESTART_WINDOW_MS = 60_000

/**
 * A range worker failed again after {@link RANGE_WORKER_RESTART_LIMIT} replacements inside the window.
 *
 * The client stops replacing it, and every later call rejects with this error.
 * `cause` holds the worker's last failure.
 *
 * @public
 */
export class RangeWorkerUnavailableError extends Error {
	constructor(cause: Error) {
		super(
			`The range worker failed ${RANGE_WORKER_RESTART_LIMIT + 1} times in ${RANGE_WORKER_RESTART_WINDOW_MS / 1000} seconds: ${cause.message}`,
			{ cause }
		)

		this.name = "RangeWorkerUnavailableError"
	}
}

/**
 * The count of range workers this page has replaced after a failure.
 */
let workerRestarts = 0

/**
 * One call awaiting the worker's reply.
 */
interface PendingCall {
	request: RangeWorkerRequest
	resolve: (value: unknown) => void
	reject: (error: Error) => void
	/**
	 * Whether a worker failed while it held this call, and the call was posted again.
	 */
	reissued: boolean
}

class RangeWorkerClient implements RangeDatabase {
	readonly #workerURL: string
	#worker: Worker
	readonly #pending = new Map<number, PendingCall>()
	#nextID = 0
	/**
	 * The open request the worker answered, replayed to each replacement worker.
	 *
	 * A range worker serves one read-only database, and this request determines its whole state.
	 */
	#opened: RangeWorkerRequest | null = null
	/**
	 * Whether a replacement worker is opening the database.
	 *
	 * A query the worker receives before its open finishes fails, so calls wait in `#held`.
	 */
	#reopening = false
	#held: PendingCall[] = []
	/**
	 * When each replacement inside the window happened, in epoch milliseconds.
	 */
	#restarts: number[] = []
	/**
	 * Why the client stopped: the worker failed before its first open,
	 * failed past the restart bound, or was closed.
	 *
	 * Every later call rejects with this error.
	 */
	#failure: Error | null = null

	constructor(workerURL: string) {
		this.#workerURL = workerURL
		this.#worker = this.#start()
		liveClients.add(this)
	}

	#start(): Worker {
		const worker = new Worker(this.#workerURL, { type: "module" })

		worker.addEventListener("message", (event: MessageEvent<RangeWorkerReply>) => {
			const reply = event.data
			const waiter = this.#pending.get(reply.id)

			// A replaced worker's late reply finds no waiter, because its calls were taken back.
			if (!waiter || worker !== this.#worker) return

			this.#pending.delete(reply.id)

			if ("error" in reply) {
				waiter.reject(new RangeWorkerError(reply.error, reply.resultCode))
			} else {
				waiter.resolve(reply.result)
			}
		})

		worker.addEventListener("error", (event) => {
			if (worker !== this.#worker || this.#failure) return

			this.#recover(new Error(event.message || `The range worker at ${this.#workerURL} failed to load`))
		})

		return worker
	}

	/**
	 * Replaces a worker that failed, replays its open, and posts again each call the failed worker held.
	 *
	 * The worker answers each call's own failure with a reply, so an `error` event means
	 * the worker itself failed and its database state is unknown.
	 *
	 * Every call is a read of an immutable database, so posting one again is safe.
	 * A call is posted again once: a call that two workers failed on rejects with the second failure.
	 */
	#recover(error: Error): void {
		const interrupted = [...this.#pending.values()]

		this.#pending.clear()

		// A worker that never opened has no state to replay, and the opener reports its failure.
		if (!this.#opened) {
			this.#stop(error, interrupted)

			return
		}

		const now = Date.now()

		this.#restarts = this.#restarts.filter((at) => now - at < RANGE_WORKER_RESTART_WINDOW_MS)

		if (this.#restarts.length >= RANGE_WORKER_RESTART_LIMIT) {
			this.#stop(new RangeWorkerUnavailableError(error), interrupted)

			return
		}

		this.#restarts.push(now)

		workerRestarts++

		for (const call of interrupted) {
			// The replayed open is the client's own call, and the next replacement replays it again.
			if (call.request === this.#opened) continue

			if (call.reissued) {
				call.reject(error)
			} else {
				call.reissued = true
				this.#held.push(call)
			}
		}

		this.#worker.terminate()
		this.#worker = this.#start()
		this.#reopening = true

		this.#post({
			request: this.#opened,
			reissued: true,
			resolve: () => {
				const held = this.#held

				this.#held = []
				this.#reopening = false

				for (const call of held) {
					this.#post(call)
				}
			},
			reject: (openError) => this.#stop(openError, []),
		})
	}

	/**
	 * Ends the client: rejects `calls` and every held call with `error`, and every later call too.
	 */
	#stop(error: Error, calls: readonly PendingCall[]): void {
		const held = this.#held

		this.#failure = error
		this.#held = []
		this.#reopening = false
		liveClients.delete(this)
		this.#worker.terminate()

		for (const call of [...calls, ...held]) {
			call.reject(error)
		}
	}

	#post(call: PendingCall): void {
		const id = this.#nextID++

		this.#pending.set(id, call)
		this.#worker.postMessage({ ...call.request, id } as RangeWorkerCall)
	}

	call<Request extends RangeWorkerRequest>(request: Request): Promise<RangeWorkerResults[Request["type"]]> {
		const reply = new Promise<unknown>((resolve, reject) => {
			if (this.#failure) {
				reject(this.#failure)

				return
			}

			const call: PendingCall = { request, resolve, reject, reissued: false }

			if (this.#reopening) {
				this.#held.push(call)

				return
			}

			this.#post(call)
		})

		// The worker answers each request type with that type's result.
		const answered = reply as Promise<RangeWorkerResults[Request["type"]]>

		if (request.type !== "open") return answered

		return answered.then((result) => {
			this.#opened = request

			return result
		})
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
		if (this.#failure) return

		const interrupted = [...this.#pending.values()]

		this.#pending.clear()
		this.#stop(new Error("The range database is closed"), interrupted)
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
 * it retries with a cache-busting query string.
 * A whole-file answer is first retried once at the same URL.
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

		// Cloudflare answers the first range request for a URL whose object is too large for
		// its cache with the whole file, and later requests for the same URL with the range.
		// A fresh query string would make a new first request, so a whole-file
		// answer is retried at the same URL first.
		if (WHOLE_FILE_ANSWER.test(String(error))) {
			try {
				return await open(databaseURL)
			} catch (error_) {
				if (!isRetriableOpenFailure(error_)) throw error_
			}
		}

		const separator = databaseURL.includes("?") ? "&" : "?"

		return open(`${databaseURL}${separator}cb=${Date.now()}`)
	}
}

/**
 * The error a range read raises when the network, or the service worker refusing it,
 * answered with the whole file.
 */
const WHOLE_FILE_ANSWER = /returned HTTP (?:200|502)\b/

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
