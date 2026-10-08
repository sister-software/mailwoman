/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Loads a slim WOF SQLite distribution into an in-memory `@sqlite.org/sqlite-wasm` database.
 *
 *   V1 strategy: fetch the whole file (~35 MB for the default top-1k US slim) and open it via the OO1
 *   API's "opfs"-flavored constructor in transient mode. The full-fetch approach is fine for a
 *   bundle this size. The browser holds the slim database in RAM for the session.
 *   HTTP/2 and gzip reduce the 35 MB transfer to one RTT plus transfer time.
 *
 *   A database too large to hold in memory is read by range requests instead, through
 *   `openRangeDatabase` in `httpvfs/database.ts`.
 */

import sqlite3InitModule, { type Database, type Sqlite3Static } from "@sqlite.org/sqlite-wasm"

export interface LoadSlimOpts {
	/**
	 * Either a URL to fetch the slim .db from, or a raw Uint8Array containing the file bytes.
	 *
	 * URL form is the public-demo path (load over http).
	 * Uint8Array form is what tests use to skip the network entirely and is
	 * also useful if a caller wants to embed the DB in their own bundler output
	 * (Vite's `?url` / `?arraybuffer` imports both produce things that fit here).
	 */
	source: string | Uint8Array
	/**
	 * Where the sqlite-wasm runtime can find its .wasm asset.
	 *
	 * Required in browser builds because the default URL is relative to the worker script.
	 * Bundlers usually rewrite that script URL.
	 *
	 * Most bundlers will let you
	 * do `new URL("../node_modules/@sqlite.org/sqlite-wasm/sqlite-wasm/jswasm/sqlite3.wasm", import.meta.url).href`.
	 *
	 * Leave unset to use the runtime's defaults (works in Node + worker contexts
	 * where the path is resolvable directly).
	 */
	wasmURL?: string
	/**
	 * Optional fetch implementation override.
	 *
	 * Useful in test harnesses that want to short-circuit network calls.
	 *
	 * @defaultValue `globalThis.fetch`
	 */
	fetchImpl?: typeof fetch
}

/**
 * Loads + opens the slim WOF DB.
 *
 * Returns `{ db, sqlite3 }`.
 * `db` is the open Database; `sqlite3` is the runtime handle
 * (in case the caller wants to call other OO1 APIs on it).
 *
 * Caller is responsible for disposing the returned database with {@link disposeSlimWOFDatabase} when done.
 */
export async function loadSlimWOFDatabase(opts: LoadSlimOpts): Promise<{ db: Database; sqlite3: Sqlite3Static }> {
	const bytes = typeof opts.source === "string" ? await fetchBytes(opts.source, opts.fetchImpl) : opts.source

	// sqlite3InitModule's TS signature lies about its options bag.
	// The runtime does accept the Emscripten-style {print, printErr, locateFile}
	// options shown in the upstream docs.
	// Cast to `any` for the call site rather than shadowing the typed wrapper for the entire file.
	const sqlite3 = await (sqlite3InitModule as (opts: Record<string, unknown>) => Promise<Sqlite3Static>)({
		print: () => {}, // suppress stdout from the WASM runtime
		printErr: (msg: string) => console.error("[sqlite-wasm]", msg),
		...(opts.wasmURL ? { locateFile: (name: string) => (name.endsWith(".wasm") ? opts.wasmURL! : name) } : {}),
	})

	// OO1 transient-DB constructor: opens an in-memory DB then we restore the file
	// bytes into it via `sqlite3.capi.sqlite3_deserialize`.
	// This is the official way to "open a Uint8Array as a database".
	// `new DB(":memory:")` followed by deserialize is faster than create table +
	// insert-from-dump and preserves the on-disk b-tree pages directly.
	const db = new sqlite3.oo1.DB(":memory:", "ct")

	// `allocFromTypedArray` has shape constraints across sqlite-wasm versions.
	// The explicit alloc + HEAPU8.set pattern is the lowest-common-denominator path
	// and avoids the "expecting 8/16/32/64" heap-shape mismatch seen on Node builds.
	const p = sqlite3.wasm.alloc(bytes.byteLength)
	const heap = sqlite3.wasm.heap8u()
	heap.set(bytes, p)

	const rc = sqlite3.capi.sqlite3_deserialize(
		db.pointer!,
		"main",
		p,
		bytes.byteLength,
		bytes.byteLength,
		sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE | sqlite3.capi.SQLITE_DESERIALIZE_RESIZEABLE
	)

	if (rc !== sqlite3.capi.SQLITE_OK) {
		sqlite3.wasm.dealloc(p)
		disposeSlimWOFDatabase(db)
		throw new Error(`sqlite3_deserialize failed: rc=${rc}`)
	}

	return { db, sqlite3 }
}

/**
 * The lifecycle boundary for sqlite-wasm.
 *
 * Its database exposes `close()` and does not use explicit resource management.
 */
export function disposeSlimWOFDatabase(db: Database): void {
	db.close()
}

async function fetchBytes(url: string, fetchImpl?: typeof fetch): Promise<Uint8Array> {
	const f = fetchImpl ?? globalThis.fetch

	if (!f) throw new Error("no fetch implementation available — pass fetchImpl in non-fetch environments")
	const res = await f(url)

	if (!res.ok) throw new Error(`fetch ${url} failed: ${res.status} ${res.statusText}`)

	return new Uint8Array(await res.arrayBuffer())
}
