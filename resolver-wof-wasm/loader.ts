/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Loads a slim WOF SQLite distribution into an in-memory `@sqlite.org/sqlite-wasm` database.
 *
 *   V1 strategy: fetch the whole file (~35 MB for the default top-1k US slim) and open it via the OO1
 *   API's "OPFS"-flavored constructor in transient mode. The full-fetch approach is fine for a
 *   bundle this size — the slim DB is what the browser holds in RAM for the duration of the session
 *   anyway, and HTTP/2 + gzip make the 35 MB transfer pay one RTT + transfer time, not the
 *   "hundreds of byte-range requests" cost a HTTP-VFS approach would incur.
 *
 *   When we eventually want incremental loading (Phase B.x), this is the seam to swap — keep
 *   `WofWasmPlaceLookup` unchanged and replace the loader with a `sql.js-httpvfs`-style VFS.
 */

import sqlite3InitModule, { type Database, type Sqlite3Static } from "@sqlite.org/sqlite-wasm"

export interface LoadSlimOpts {
	/**
	 * Either a URL to fetch the slim .db from, or a raw Uint8Array containing the file bytes.
	 *
	 * URL form is the public-demo path (load over HTTP). Uint8Array form is what tests use to skip
	 * the network entirely and is also useful if a caller wants to embed the DB in their own bundler
	 * output (Vite's `?url` / `?arraybuffer` imports both produce things that fit here).
	 */
	source: string | Uint8Array
	/**
	 * Where the sqlite-wasm runtime can find its .wasm asset. Required in browser builds because the
	 * default URL is resolved relative to the worker script, which bundlers usually rewrite.
	 *
	 * Most bundlers will let you do `new
	 * URL("../node_modules/@sqlite.org/sqlite-wasm/sqlite-wasm/jswasm/sqlite3.wasm",
	 * import.meta.url).href`.
	 *
	 * Leave unset to use the runtime's defaults (works in Node + worker contexts where the path is
	 * resolvable directly).
	 */
	wasmUrl?: string
	/**
	 * Optional fetch implementation override. Defaults to `globalThis.fetch`. Useful in test
	 * harnesses that want to short-circuit network calls.
	 */
	fetchImpl?: typeof fetch
}

/**
 * Loads + opens the slim WOF DB. Returns `{ db, sqlite3 }` — `db` is the open Database; `sqlite3`
 * is the runtime handle (in case the caller wants to call other OO1 APIs on it).
 *
 * Caller is responsible for `db.close()` when done.
 */
export async function loadSlimWofDatabase(opts: LoadSlimOpts): Promise<{ db: Database; sqlite3: Sqlite3Static }> {
	const bytes = typeof opts.source === "string" ? await fetchBytes(opts.source, opts.fetchImpl) : opts.source

	const sqlite3 = await sqlite3InitModule({
		print: () => {}, // suppress stdout from the WASM runtime
		printErr: (msg: string) => console.error("[sqlite-wasm]", msg),
		...(opts.wasmUrl ? { locateFile: (name: string) => (name.endsWith(".wasm") ? opts.wasmUrl! : name) } : {}),
	})

	// OO1 transient-DB constructor: opens an in-memory DB then we restore the file bytes into it
	// via `sqlite3.capi.sqlite3_deserialize`. This is the official way to "open a Uint8Array as a
	// database" — `new DB(":memory:")` followed by deserialize is faster than CREATE TABLE +
	// INSERT-from-dump and preserves the on-disk b-tree pages directly.
	const db = new sqlite3.oo1.DB(":memory:", "ct")

	// `allocFromTypedArray` has shape constraints across sqlite-wasm versions; the
	// explicit alloc + HEAPU8.set pattern is the lowest-common-denominator path and
	// avoids the "expecting 8/16/32/64" heap-shape mismatch seen on Node builds.
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
		db.close()
		throw new Error(`sqlite3_deserialize failed: rc=${rc}`)
	}

	return { db, sqlite3 }
}

async function fetchBytes(url: string, fetchImpl?: typeof fetch): Promise<Uint8Array> {
	const f = fetchImpl ?? globalThis.fetch
	if (!f) throw new Error("no fetch implementation available — pass fetchImpl in non-fetch environments")
	const res = await f(url)
	if (!res.ok) throw new Error(`fetch ${url} failed: ${res.status} ${res.statusText}`)
	return new Uint8Array(await res.arrayBuffer())
}
