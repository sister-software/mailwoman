/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * The dedicated-worker script behind `openRangeDatabase`. It registers a read-only SQLite VFS whose file is
 * one remote database, read by HTTP range requests, and answers the messages in `worker-protocol.ts`.
 *
 * A host stages the compiled script beside the sqlite-wasm runtime and the page loads it by URL. The
 * script therefore has type-only imports: a runtime import would name a file the host never staged.
 *
 * SQLite calls `xRead` synchronously, so each range request is a synchronous `XMLHttpRequest`, which
 * browsers permit inside a worker.
 */

import type { Database, PreparedStatement, Sqlite3Static } from "@sqlite.org/sqlite-wasm"

import type { RangeWorkerCall, RangeWorkerReply, RangeWorkerResults, SQLValue } from "./worker-protocol.ts"

const HTTP_PARTIAL_CONTENT = 206
const VFS_NAME = "http-range"
const MAX_PATHNAME_BYTES = 1024

/**
 * The number of prepared statements kept between queries.
 *
 * The lookups issue a fixed set of statement texts, so this bound is reached only
 * by statements whose `IN (…)` list varies in length.
 */
const STATEMENT_CACHE_LIMIT = 64

/**
 * The one remote file this worker serves, with the chunks fetched so far.
 */
interface RemoteFile {
	url: string
	chunkSize: number

	/**
	 * The file's length in bytes, read from the first response's `Content-Range`.
	 */
	size: number
	chunks: Map<number, Uint8Array>
	requests: number
	bytes: number
}

let remote: RemoteFile | undefined
let database: Database | undefined
const statements = new Map<string, PreparedStatement>()

function fetchRange(file: RemoteFile, start: number, end: number): Uint8Array {
	const request = new XMLHttpRequest()

	request.open("GET", file.url, false)
	request.responseType = "arraybuffer"
	request.setRequestHeader("Range", `bytes=${start}-${end}`)
	request.send()

	if (request.status !== HTTP_PARTIAL_CONTENT) {
		throw new Error(`Range ${start}-${end} of ${file.url} returned HTTP ${request.status}`)
	}

	const total = /\/(\d+)$/u.exec(request.getResponseHeader("Content-Range") ?? "")

	if (!total) {
		throw new Error(`Range ${start}-${end} of ${file.url} returned no Content-Range total`)
	}

	const body = new Uint8Array(request.response as ArrayBuffer)
	const expected = Math.min(end, Number(total[1]) - 1) - start + 1

	// A truncated body would reach SQLite as a malformed page, so it is refused here by length.
	if (body.byteLength !== expected) {
		throw new Error(`Range ${start}-${end} of ${file.url} returned ${body.byteLength} bytes, expected ${expected}`)
	}

	file.size = Number(total[1])

	file.requests++
	file.bytes += body.byteLength

	return body
}

/**
 * Returns chunk `index` of the file, fetching it on first use.
 *
 * Every request covers one whole chunk at an offset that is a multiple of the chunk size, so the same
 * read always produces the same `Range` header and an HTTP or service-worker cache can answer it.
 */
function chunkAt(file: RemoteFile, index: number): Uint8Array {
	let chunk = file.chunks.get(index)

	if (!chunk) {
		const start = index * file.chunkSize

		chunk = fetchRange(file, start, start + file.chunkSize - 1)
		file.chunks.set(index, chunk)
	}

	return chunk
}

/**
 * Returns a struct wrapper as a record of its C members.
 *
 * A wrapper exposes every member under a `$` prefix, and the published types declare only some of them.
 */
function structMembers(struct: object): Record<string, unknown> {
	return struct as Record<string, unknown>
}

const UINT32_RANGE = 2 ** 32

function installRangeVFS(sqlite3: Sqlite3Static, file: RemoteFile): void {
	const { capi, wasm } = sqlite3
	const ioMethods = new capi.sqlite3_io_methods()
	const vfs = new capi.sqlite3_vfs()
	const defaultVFS = new capi.sqlite3_vfs(capi.sqlite3_vfs_find(null))

	const fileStruct = new capi.sqlite3_file()

	vfs.$iVersion = 1
	vfs.$szOsFile = fileStruct.structInfo.sizeof
	vfs.$mxPathname = MAX_PATHNAME_BYTES
	fileStruct.dispose()

	structMembers(ioMethods).$iVersion = 1

	// SQLite requires these four methods of every VFS, and the default VFS's implementations do not touch a file.
	for (const inherited of ["$xRandomness", "$xSleep", "$xCurrentTime", "$xCurrentTimeInt64"]) {
		structMembers(vfs)[inherited] = structMembers(defaultVFS)[inherited]
	}

	sqlite3.vfs.installVfs({
		io: {
			struct: ioMethods,
			methods: {
				xRead(_file, destination, amount, offset) {
					try {
						// The offset arrives as a BigInt in the 64-bit build this package loads.
						let position = Number(offset)
						let written = 0

						while (written < amount && position < file.size) {
							const index = Math.floor(position / file.chunkSize)
							const within = position - index * file.chunkSize
							const chunk = chunkAt(file, index)
							const take = Math.min(amount - written, chunk.byteLength - within)

							if (take <= 0) break

							wasm.heap8u().set(chunk.subarray(within, within + take), Number(destination) + written)
							written += take
							position += take
						}

						if (written < amount) {
							wasm.heap8u().fill(0, Number(destination) + written, Number(destination) + amount)

							return capi.SQLITE_IOERR_SHORT_READ
						}

						return capi.SQLITE_OK
					} catch (error) {
						console.error(error)

						return capi.SQLITE_IOERR_READ
					}
				},
				xFileSize(_file, sizeOut) {
					// The size is a little-endian `i64`, written as its low and high 32-bit halves.
					wasm.poke(sizeOut, file.size % UINT32_RANGE, "i32")
					wasm.poke(Number(sizeOut) + 4, Math.floor(file.size / UINT32_RANGE), "i32")

					return capi.SQLITE_OK
				},
				xCheckReservedLock(_file, resultOut) {
					wasm.poke(resultOut, 0, "i32")

					return capi.SQLITE_OK
				},
				xClose: () => capi.SQLITE_OK,
				xLock: () => capi.SQLITE_OK,
				xUnlock: () => capi.SQLITE_OK,
				xSync: () => capi.SQLITE_OK,
				xFileControl: () => capi.SQLITE_NOTFOUND,
				// The published return type is a result code, and this method returns a capability bit mask.
				xDeviceCharacteristics: () => capi.SQLITE_IOCAP_IMMUTABLE as number as ReturnType<typeof capi.sqlite3_errcode>,
				xWrite: () => capi.SQLITE_READONLY,
				xTruncate: () => capi.SQLITE_READONLY,
			},
		},
		vfs: {
			struct: vfs,
			name: VFS_NAME,
			methods: {
				xOpen(_vfs, _name, filePointer, _flags, flagsOut) {
					const opened = new capi.sqlite3_file(filePointer)

					opened.$pMethods = ioMethods.pointer
					opened.dispose()

					if (flagsOut) {
						wasm.poke(flagsOut, capi.SQLITE_OPEN_READONLY, "i32")
					}

					return capi.SQLITE_OK
				},
				// The database is opened immutable, so SQLite asks only whether a journal exists.
				// None does.
				xAccess(_vfs, _name, _flags, resultOut) {
					wasm.poke(resultOut, 0, "i32")

					return capi.SQLITE_OK
				},
				xFullPathname(_vfs, name, capacity, pathOut) {
					return wasm.cstrncpy(pathOut, name, capacity) < capacity ? capi.SQLITE_OK : capi.SQLITE_CANTOPEN
				},
				xDelete: () => capi.SQLITE_READONLY,
				xGetLastError: () => {},
			},
		},
	})
}

async function open(request: Extract<RangeWorkerCall, { type: "open" }>): Promise<RangeWorkerResults["open"]> {
	const { default: initialize } = (await import(
		/* @vite-ignore */ /* webpackIgnore: true */ request.runtimeModuleURL
	)) as typeof import("@sqlite.org/sqlite-wasm")

	const sqlite3 = await (initialize as (options: Record<string, unknown>) => Promise<Sqlite3Static>)({
		print: () => {},
		printErr: (message: string) => console.error("[sqlite-wasm]", message),
	})

	const file: RemoteFile = {
		url: request.databaseURL,
		chunkSize: request.chunkSize,
		size: 0,
		chunks: new Map(),
		requests: 0,
		bytes: 0,
	}

	// The first chunk holds the database header, and its response gives the file's length.
	chunkAt(file, 0)
	installRangeVFS(sqlite3, file)

	remote = file
	database = new sqlite3.oo1.DB("file:remote.db?immutable=1", "r", VFS_NAME)

	return { sqliteVersion: sqlite3.capi.sqlite3_libversion() }
}

function prepared(sql: string): PreparedStatement {
	if (!database) throw new Error("The range database is not open")

	let statement = statements.get(sql)

	if (statement) return statement

	if (statements.size >= STATEMENT_CACHE_LIMIT) {
		const [oldestSQL, oldest] = statements.entries().next().value!

		oldest.finalize()
		statements.delete(oldestSQL)
	}

	statement = database.prepare(sql)
	statements.set(sql, statement)

	return statement
}

function query(request: Extract<RangeWorkerCall, { type: "query" }>): RangeWorkerResults["query"] {
	const statement = prepared(request.sql)
	const rows: Record<string, SQLValue>[] = []

	try {
		if (request.parameters.length) {
			statement.bind(request.parameters as SQLValue[])
		}

		while (statement.step()) {
			rows.push(statement.get({}) as Record<string, SQLValue>)
		}
	} finally {
		statement.reset(true)
	}

	return rows
}

async function answer(call: RangeWorkerCall): Promise<RangeWorkerResults[keyof RangeWorkerResults]> {
	switch (call.type) {
		case "open":
			return open(call)
		case "query":
			return query(call)
		case "stats":
			return { requests: remote?.requests ?? 0, bytes: remote?.bytes ?? 0 }
	}
}

globalThis.addEventListener("message", (event: MessageEvent<RangeWorkerCall>) => {
	const call = event.data
	const reply = (message: RangeWorkerReply): void => globalThis.postMessage(message)

	answer(call).then(
		(result) => reply({ id: call.id, result }),
		(error: unknown) => reply({ id: call.id, error: error instanceof Error ? error.message : String(error) })
	)
})
