/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   What a host must stage to serve the httpvfs readers: sql.js-httpvfs's UMD bundle, its worker and its WASM, loaded
 *   at run time by URL (the UMD via a classic script tag, the worker and WASM handed to `createDbWorker`), so no bundler
 *   ever sees them. Node-side, a build step, never the browser. `syncArtifact` is the idempotent copy every staged asset
 *   goes through: a size-identical destination is left alone so a dev server watching it sees no change.
 */

import { ByteFormatter } from "@mailwoman/core/fs/formatters"
import { pathExists, statPath } from "@mailwoman/core/fs/readers"
import { copyFileTo } from "@mailwoman/core/fs/writers"
import { tryResolvePackageSpecifier } from "@mailwoman/core/module/resolve-from"
import { dirname, resolvePath } from "path-ts"

/**
 * Copy a file to the static directory, but only if it differs (by size) from what's already there.
 *
 * @param label - For logging
 *
 * @returns True if the file was copied
 */
export async function syncArtifact(sourcePath: string, destPath: string, label: string): Promise<boolean> {
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
 * Stage sql.js-httpvfs's runtime assets (the UMD bundle + its Worker + WASM) into `destDir`. The demo loads these at
 * RUNTIME by URL — the UMD via a classic <script>, the worker + wasm passed to createDbWorker — so webpack never sees
 * them. That's deliberate: bundling sql.js-httpvfs (a webpack UMD bundle with dynamic Worker/wasm requires) is exactly
 * what produces "Critical dependency" build warnings, so we keep it out of the graph entirely.
 *
 * @param destDir - E.g. static/mailwoman/sqljs
 */
export async function stageSQLJSAssets(destDir: string): Promise<boolean> {
	// The runtime files live under the package's `dist/`, so the anchor is the bundle inside it, not the manifest at
	// the package root.
	const entry = tryResolvePackageSpecifier(import.meta.url, "sql.js-httpvfs", "dist/index.js")

	if (!entry) {
		console.warn("[host-assets] sql.js-httpvfs not resolvable — HTTP-VFS assets not staged")

		return false
	}

	const distDir = dirname(entry)

	const files = ["index.js", "sqlite.worker.js", "sql-wasm.wasm"]
	let copied = 0

	for (const f of files) {
		const src = resolvePath(distDir, f)

		if (!(await pathExists(src))) {
			console.warn(`[host-assets] sql.js-httpvfs: missing ${f} in dist`)

			return false
		}

		const dest = resolvePath(destDir, f)

		// Idempotent stage — syncArtifact skips a size-identical copy. This runs in loadContent(), which
		// the Docusaurus dev server (`yarn start`) re-invokes on reload — and `destDir` lives under the
		// watched `static/` tree. An UNCONDITIONAL copy rewrites the file (fresh mtime) even when the
		// bytes are identical, the watcher sees a "change" and reloads, loadContent() re-runs and
		// re-copies… a reload LOOP that shows up as the /demo page flickering during `start`. Skipping
		// the no-op copy breaks the cycle. (Prod `build` runs loadContent once, so the loop is a
		// dev-server-only hazard.)
		if (await syncArtifact(src, dest, `sql.js-httpvfs ${f}`)) {
			copied++
		}
	}

	if (copied > 0) {
		console.log(`[host-assets] sql.js-httpvfs: staged ${copied} runtime asset(s)`)
	}

	return true
}
