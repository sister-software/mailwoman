/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Named-export stubs for Node builtins the client bundle can SEE but must never RUN, wired as
 *   webpack `fallback`s in `plugin.ts` beside `node-path-shim.js`. A `false` fallback yields an
 *   empty module, which works for namespace/default imports but makes every NAMED import a hard
 *   compile error. The source-aliased `@mailwoman/*` graph pulls spliterator's file/worker side
 *   into the client (dead code there — browsers parse text they already hold), so the stubs only
 *   need to satisfy the compiler; calling one throws with the import to blame (2026-08-05 build
 *   break: posix/open/stat/createWriteStream/Worker/WritableStream).
 *
 *   One file, one `#stub` factory — export groups mirror the builtin specifiers listed in
 *   plugin.ts. `node:stream/web` is the exception: browsers implement those classes natively, so
 *   it re-exports the globals rather than throwing.
 */

/* oxlint-disable sister-software/require-constant-doc -- every export is the same mechanical
 * throwing stub; the @file block above is the single documentation site, and 25 identical JSDoc
 * blocks would bury the two real comments in this file. */

function stub(builtin, name) {
	return function stubbed() {
		throw new Error(`${builtin}.${name} is Node-only and reached the browser bundle — this path must stay dead.`)
	}
}

//#region node:fs/promises

export const open = stub("node:fs/promises", "open")
export const stat = stub("node:fs/promises", "stat")
export const lstat = stub("node:fs/promises", "lstat")
export const readFile = stub("node:fs/promises", "readFile")
export const writeFile = stub("node:fs/promises", "writeFile")
export const readdir = stub("node:fs/promises", "readdir")
export const mkdir = stub("node:fs/promises", "mkdir")
export const unlink = stub("node:fs/promises", "unlink")
export const rm = stub("node:fs/promises", "rm")
export const access = stub("node:fs/promises", "access")
export const realpath = stub("node:fs/promises", "realpath")

//#endregion

//#region node:fs

export const createReadStream = stub("node:fs", "createReadStream")
export const createWriteStream = stub("node:fs", "createWriteStream")
export const existsSync = stub("node:fs", "existsSync")
export const readFileSync = stub("node:fs", "readFileSync")
export const writeFileSync = stub("node:fs", "writeFileSync")
export const statSync = stub("node:fs", "statSync")
export const mkdirSync = stub("node:fs", "mkdirSync")
export const readdirSync = stub("node:fs", "readdirSync")
export const unlinkSync = stub("node:fs", "unlinkSync")

//#endregion

//#region node:worker_threads

export class Worker {
	constructor() {
		throw new Error(
			"node:worker_threads.Worker is Node-only and reached the browser bundle — this path must stay dead."
		)
	}
}

export const isMainThread = true
export const parentPort = null
export const workerData = undefined

//#endregion

//#region node:stream/web (native passthrough)

export const ReadableStream = globalThis.ReadableStream
export const WritableStream = globalThis.WritableStream
export const TransformStream = globalThis.TransformStream

//#endregion

export default {
	open,
	stat,
	lstat,
	readFile,
	writeFile,
	readdir,
	mkdir,
	unlink,
	rm,
	access,
	realpath,
	createReadStream,
	createWriteStream,
	existsSync,
	readFileSync,
	writeFileSync,
	statSync,
	mkdirSync,
	readdirSync,
	unlinkSync,
	Worker,
	isMainThread,
	parentPort,
	workerData,
	ReadableStream,
	WritableStream,
	TransformStream,
}
