/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   A read-only SQLite database whose pages are R2 range reads, implementing the browser resolver's `RangeDatabase`
 *   so `WOFCandidateTableLookup` runs on it unchanged. The browser reader answers SQLite's synchronous page reads with
 *   synchronous XHR in a Web Worker, and a Cloudflare Worker has no synchronous XHR. The JSPI build of wa-sqlite lets the VFS's
 *   `jRead` await an R2 read instead.
 */

import type { R2Bucket } from "@cloudflare/workers-types"
import * as SQLite from "@journeyapps/wa-sqlite"
import SQLiteESMFactory from "@journeyapps/wa-sqlite/dist/wa-sqlite-jspi.mjs"
import sqliteModule from "@journeyapps/wa-sqlite/dist/wa-sqlite-jspi.wasm"
import { FacadeVFS } from "@journeyapps/wa-sqlite/src/FacadeVFS.js"
import * as VFS from "@journeyapps/wa-sqlite/src/VFS.js"
import type { RangeDatabase } from "@mailwoman/resolver-wof-wasm/httpvfs/database"
import type { SQLValue } from "@mailwoman/resolver-wof-wasm/httpvfs/worker-protocol"

/**
 * The name the VFS opens.
 *
 * The database has one file, so the name only has to match between `open_v2` and `jOpen`.
 */
const FILE_NAME = "candidate.db"

/**
 * Tunes how {@link openR2Database} reads and caches the object.
 */
export interface R2DatabaseOptions {
	/**
	 * The bytes per R2 range read.
	 *
	 * @defaultValue 65,536, eight 8 KiB SQLite pages, the browser reader's chunk
	 */
	chunkSize?: number
	/**
	 * The chunks kept in memory, least recently used evicted first.
	 *
	 * @defaultValue 256, a 16 MiB cache at the default chunk size
	 */
	maxChunks?: number
}

/**
 * The read counters a {@link R2Database} reports.
 */
export interface R2DatabaseStats {
	/**
	 * Bytes read from R2 since the database opened.
	 */
	bytes: number
	/**
	 * R2 range reads since the database opened.
	 */
	requests: number
	/**
	 * Chunks currently held in the cache.
	 */
	cachedChunks: number
}

/**
 * A {@link RangeDatabase} over one R2 object, with its read counters.
 */
export interface R2Database extends RangeDatabase {
	stats(): R2DatabaseStats
}

/**
 * The object being read and the chunks read from it, least recently used first.
 */
interface RemoteObject {
	bucket: R2Bucket
	key: string
	size: number
	chunkSize: number
	maxChunks: number
	chunks: Map<number, Uint8Array>
	stats: R2DatabaseStats
}

async function readChunk(object: RemoteObject, index: number): Promise<Uint8Array> {
	const cached = object.chunks.get(index)

	if (cached) {
		object.chunks.delete(index)
		object.chunks.set(index, cached)

		return cached
	}

	const offset = index * object.chunkSize
	const length = Math.min(object.chunkSize, object.size - offset)
	const body = await object.bucket.get(object.key, { range: { offset, length } })

	if (!body) throw new Error(`R2 object ${object.key} disappeared while open`)

	const chunk = new Uint8Array(await body.arrayBuffer())

	if (chunk.byteLength !== length) {
		throw new Error(`R2 range ${offset}+${length} of ${object.key} returned ${chunk.byteLength} bytes`)
	}

	object.stats.bytes += chunk.byteLength

	object.stats.requests++
	object.chunks.set(index, chunk)

	if (object.chunks.size > object.maxChunks) {
		const oldest = object.chunks.keys().next().value

		if (typeof oldest === "number") {
			object.chunks.delete(oldest)
		}
	}

	return chunk
}

/**
 * A read-only VFS over one R2 object.
 *
 * Every method but `jRead` answers from the object's size.
 * The VFS reads that size when it opens the object.
 */
class R2VFS extends FacadeVFS {
	readonly #object: RemoteObject

	constructor(module: object, object: RemoteObject) {
		super("r2", module)
		this.#object = object
	}

	override jOpen(filename: string | null, _pFile: number, _flags: number, pOutFlags: DataView): number {
		if (filename !== FILE_NAME) return VFS.SQLITE_CANTOPEN

		pOutFlags.setInt32(0, VFS.SQLITE_OPEN_READONLY, true)

		return VFS.SQLITE_OK
	}

	override async jRead(_pFile: number, pData: Uint8Array, iOffset: number): Promise<number> {
		const object = this.#object
		const available = Math.max(0, Math.min(pData.byteLength, object.size - iOffset))
		let written = 0

		while (written < available) {
			const position = iOffset + written
			const index = Math.floor(position / object.chunkSize)
			const within = position - index * object.chunkSize
			const chunk = await readChunk(object, index)
			const take = Math.min(available - written, chunk.byteLength - within)

			pData.set(chunk.subarray(within, within + take), written)
			written += take
		}

		if (written < pData.byteLength) {
			pData.fill(0, written)

			return VFS.SQLITE_IOERR_SHORT_READ
		}

		return VFS.SQLITE_OK
	}

	override jFileSize(_pFile: number, pSize64: DataView): number {
		pSize64.setBigInt64(0, BigInt(this.#object.size), true)

		return VFS.SQLITE_OK
	}

	override jAccess(filename: string, _flags: number, pResOut: DataView): number {
		pResOut.setInt32(0, filename === FILE_NAME ? 1 : 0, true)

		return VFS.SQLITE_OK
	}

	override jDeviceCharacteristics(): number {
		return VFS.SQLITE_IOCAP_IMMUTABLE
	}
}

/**
 * Opens the SQLite database stored at `key` in `bucket` for range reads.
 *
 * Queries run one after another, because SQLite's single connection holds one
 * statement's suspended read at a time.
 */
export async function openR2Database(
	bucket: R2Bucket,
	key: string,
	{ chunkSize = 65_536, maxChunks = 256 }: R2DatabaseOptions = {}
): Promise<R2Database> {
	const head = await bucket.head(key)

	if (!head) throw new Error(`R2 object ${key} is absent from the bucket`)

	const object: RemoteObject = {
		bucket,
		key,
		size: head.size,
		chunkSize,
		maxChunks,
		chunks: new Map(),
		stats: { bytes: 0, requests: 0, cachedChunks: 0 },
	}

	const module = await SQLiteESMFactory({
		// Without `locateFile` the loader resolves its binary against `import.meta.url`, which a bundle leaves invalid.
		locateFile: (path: string) => path,
		// workerd refuses to compile WebAssembly from bytes, so the loader instantiates the module wrangler bundled.
		instantiateWasm(imports: WebAssembly.Imports, receive: (instance: WebAssembly.Instance) => void) {
			void WebAssembly.instantiate(sqliteModule, imports).then(receive)

			return {}
		},
	})

	const sqlite3 = SQLite.Factory(module)

	sqlite3.vfs_register(new R2VFS(module, object), false)

	const db = await sqlite3.open_v2(FILE_NAME, SQLite.SQLITE_OPEN_READONLY, "r2")
	let queue: Promise<unknown> = Promise.resolve()

	async function run<Row>(sql: string, parameters: readonly SQLValue[]): Promise<Row[]> {
		const rows: Row[] = []

		for await (const stmt of sqlite3.statements(db, sql)) {
			if (parameters.length) {
				sqlite3.bind_collection(stmt, [...parameters])
			}

			const columns = sqlite3.column_names(stmt)

			while ((await sqlite3.step(stmt)) === SQLite.SQLITE_ROW) {
				const values = sqlite3.row(stmt)

				rows.push(Object.fromEntries(columns.map((column, index) => [column, values[index]])) as Row)
			}
		}

		return rows
	}

	return {
		query<Row = Record<string, SQLValue>>(sql: string, parameters: readonly SQLValue[] = []): Promise<Row[]> {
			const next = queue.then(() => run<Row>(sql, parameters))

			queue = next.catch(() => undefined)

			return next
		},
		async bytesRead() {
			return object.stats.bytes
		},
		stats() {
			return { ...object.stats, cachedChunks: object.chunks.size }
		},
	}
}
