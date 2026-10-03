/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * The page's handle on a remote SQLite database read by HTTP range requests.
 *
 * `openRangeDatabase` starts the worker in `range-worker.ts`, which runs `@sqlite.org/sqlite-wasm` over a
 * read-only VFS. The browser lookups in this directory take the {@link RangeDatabase} it returns.
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
}

/**
 * The default bytes per range request, eight 8 KiB SQLite pages.
 *
 * On 16 cold name probes of the candidate table a 64 KiB chunk issued 55 requests
 * and an 8 KiB chunk issued 84.
 */
export const DEFAULT_CHUNK_SIZE = 65_536

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

class RangeWorkerClient implements RangeDatabase {
	readonly #worker: Worker
	readonly #pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
	#nextID = 0

	constructor(workerURL: string) {
		this.#worker = new Worker(workerURL, { type: "module" })

		this.#worker.addEventListener("message", (event: MessageEvent<RangeWorkerReply>) => {
			const reply = event.data
			const waiter = this.#pending.get(reply.id)

			if (!waiter) return

			this.#pending.delete(reply.id)

			if ("error" in reply) {
				waiter.reject(new Error(reply.error))
			} else {
				waiter.resolve(reply.result)
			}
		})

		this.#worker.addEventListener("error", (event) => {
			const error = new Error(event.message || `The range worker at ${workerURL} failed to load`)

			for (const waiter of this.#pending.values()) {
				waiter.reject(error)
			}

			this.#pending.clear()
		})
	}

	call<Request extends RangeWorkerRequest>(request: Request): Promise<RangeWorkerResults[Request["type"]]> {
		const reply = new Promise<unknown>((resolve, reject) => {
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
		this.#worker.terminate()
	}
}

/**
 * Opens the SQLite database at `databaseURL` for range-request reads.
 *
 * `runtimeBaseURL` is the same-origin directory where the host staged the worker script
 * and the sqlite-wasm runtime.
 *
 * If the first open reports a malformed database, it retries once with a cache-busting
 * query string, because a stale cached response can serve bytes from an older file.
 */
export async function openRangeDatabase(
	databaseURL: string,
	runtimeBaseURL: string,
	options: RangeDatabaseOptions = {}
): Promise<RangeDatabase> {
	const base = new URL(runtimeBaseURL.endsWith("/") ? runtimeBaseURL : `${runtimeBaseURL}/`, globalThis.location.href)

	const open = async (url: string): Promise<RangeDatabase> => {
		const client = new RangeWorkerClient(new URL(RANGE_WORKER_FILE, base).href)

		try {
			await client.call({
				type: "open",
				databaseURL: new URL(url, globalThis.location.href).href,
				runtimeModuleURL: new URL(SQLITE_RUNTIME_MODULE_FILE, base).href,
				chunkSize: options.chunkSize ?? DEFAULT_CHUNK_SIZE,
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
		if (!/malformed|not a database|disk image/i.test(String(error))) throw error

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

/**
 * Memoizes a zero-argument async probe as its in-flight promise so concurrent callers share one query.
 *
 * A rejection clears the memo so a transient failure can retry.
 */
export function memoizeResettable<T>(fn: () => Promise<T>): () => Promise<T> {
	let memo: Promise<T> | undefined

	return () => {
		if (!memo) {
			memo = fn()

			memo.catch(() => {
				memo = undefined
			})
		}

		return memo
	}
}
