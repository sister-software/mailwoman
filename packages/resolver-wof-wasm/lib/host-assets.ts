/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   What a host must stage to serve the httpvfs readers: this package's compiled range worker and the
 *   `@sqlite.org/sqlite-wasm` runtime it imports, all loaded at run time by URL, so no bundler ever sees them.
 *   Node-side, a build step, never the browser. `syncArtifact` is the idempotent copy every staged asset goes
 *   through: a size-identical destination remains unchanged so a dev server watching it sees no change.
 */

import { ByteFormatter } from "@mailwoman/core/fs/formatters"
import { pathExists, statPath } from "@mailwoman/core/fs/readers"
import { copyFileTo } from "@mailwoman/core/fs/writers"
import { tryResolvePackageSpecifier } from "@mailwoman/core/module/resolve-from"
import { dirname, resolvePath, type PathBuilderLike } from "path-ts"

import { RANGE_WORKER_FILE, SQLITE_RUNTIME_MODULE_FILE } from "#httpvfs/database"

/**
 * Copy a file to the static directory, but only if it differs (by size) from what's already there.
 *
 * @param label - For logging
 *
 * @returns True if the file was copied
 */
export async function syncArtifact(
	sourcePath: PathBuilderLike,
	destPath: PathBuilderLike,
	label: string
): Promise<boolean> {
	if (!(await pathExists(sourcePath))) {
		console.warn(`[host-assets] ${label}: source missing at ${sourcePath}`)

		return false
	}

	const sourceSize = (await statPath(sourcePath)).size

	if (await pathExists(destPath)) {
		const destSize = (await statPath(destPath)).size

		if (sourceSize === destSize) return false
	}

	await copyFileTo(sourcePath, destPath)

	console.log(`[host-assets] ${label}: synced (${ByteFormatter.formatIEC(sourceSize)})`)

	return true
}

/**
 * The sqlite-wasm files the range worker loads from the staged directory.
 *
 * The runtime module finds `sqlite3.wasm` and the OPFS proxy beside itself through `import.meta.url`.
 * The range reader never opens an OPFS database, and the runtime still requests
 * the proxy on a cross-origin-isolated page.
 */
const SQLITE_RUNTIME_FILES = [SQLITE_RUNTIME_MODULE_FILE, "sqlite3.wasm", "sqlite3-opfs-async-proxy.js"]

/**
 * Stage the range worker and the sqlite-wasm runtime into `destDir`.
 *
 * The page starts the worker by URL and the worker imports the runtime by URL,
 * so no bundler processes either file.
 * The worker is this package's compiled `out/httpvfs/range-worker.js`,
 * so the package must be compiled before a host stages it.
 *
 * @param destDir - E.g. static/mailwoman/sqlite
 */
export async function stageSQLiteRuntimeAssets(destDir: PathBuilderLike): Promise<boolean> {
	// `sqlite3.wasm` is the one file of the runtime directory the package's export map names.
	const wasm = tryResolvePackageSpecifier(import.meta.url, "@sqlite.org/sqlite-wasm", "sqlite3.wasm")

	// This module is also loaded by Docusaurus as CommonJS, where `import.meta.resolve` is unavailable.
	// The package directory is therefore found through `createRequire`, by way of its own manifest.
	const manifest = tryResolvePackageSpecifier(import.meta.url, "@mailwoman/resolver-wof-wasm", "package.json")

	if (!wasm || !manifest) {
		console.warn("[host-assets] @sqlite.org/sqlite-wasm not resolvable — range reader assets not staged")

		return false
	}

	const runtimeDir = dirname(wasm)

	const sources: Array<[file: string, source: PathBuilderLike]> = [
		[RANGE_WORKER_FILE, resolvePath(dirname(manifest), "out", "httpvfs", RANGE_WORKER_FILE)],
		...SQLITE_RUNTIME_FILES.map((file): [string, PathBuilderLike] => [file, resolvePath(runtimeDir, file)]),
	]

	let copied = 0

	for (const [f, src] of sources) {
		if (!(await pathExists(src))) {
			console.warn(`[host-assets] range reader: missing ${f} at ${src}`)

			return false
		}

		const dest = resolvePath(destDir, f)

		// Idempotent stage — syncArtifact skips a size-identical copy.
		// This runs in loadContent(), which the Docusaurus dev server (`yarn start`) re-invokes on reload.
		// `destDir` lives under the watched `static/` tree.
		// An unconditional copy rewrites the file (fresh mtime) even when the bytes are identical,
		// the watcher sees a "change" and reloads, loadContent() re-runs and re-copies… a
		// reload loop that shows up as the /demo page flickering during `start`.
		// A no-op copy breaks the cycle when the host does not skip it.
		// (Prod `build` runs loadContent once, so the loop is a dev-server-only hazard.)
		if (await syncArtifact(src, dest, `range reader ${f}`)) {
			copied++
		}
	}

	if (copied > 0) {
		console.log(`[host-assets] range reader: staged ${copied} runtime asset(s)`)
	}

	return true
}
