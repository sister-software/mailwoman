/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build-time utilities for the demo-assets plugin. Resolves workspace packages and their
 *   sub-entrypoints, copies + validates model artifacts, and builds the FST gazetteer binary.
 *
 *   Runs in Node.js only (Docusaurus config / plugin context). Never bundled into the client.
 *
 *   WHY `createRequire` AND NOT `import.meta.resolve` (2026-08-05 triage). Two reasons, and the
 *   second is the one that would bite.
 *
 *   What the callers want back is a package DIRECTORY, which `import.meta.resolve` does not return.
 *   It answers "which ONE file does this specifier import" — precisely the answer these aliases
 *   exist to OVERRIDE. They point webpack at source `.ts` rather than the `out/` JS the exports
 *   map's `default` condition selects, and at `core/resolver/types` rather than the
 *   `@mailwoman/resolver` barrel that re-exports it, so resolving them WITH the resolver is
 *   circular. The package-aware helpers therefore resolve source entries directly and keep package
 *   roots out of webpack-policy callers.
 *
 *   And this file does not run under plain Node; it runs under Docusaurus's config loader, where
 *   `import.meta.resolve` is not something to assume. `docs` declares no `"type": "module"`, and
 *   the sibling `plugin.ts` calls a BARE `require.resolve` (no `createRequire`) inside its
 *   `NormalModuleReplacementPlugin` hook — which only works if the loader hands these modules a CJS
 *   `require`, and CJS has no `import.meta` at all. `createRequire(import.meta.url)` survives that
 *   because transpilers rewrite `import.meta.url`; `import.meta.resolve` has no such rewrite.
 *   (Contrast `docs/scripts/generate-cli-reference.ts`, which the `prebuild` runs as `node <file>`
 *   — real ESM, and it uses `import.meta.resolve`.)
 *
 *   So the one sub-site here that IS a plain resolution — the `@mailwoman/codex` loop below, which
 *   deliberately asks the resolver instead of hand-deriving paths — stays on `require.resolve` too.
 *   Only a docs BUILD can verify a change to that, never a unit test.
 */

import { ByteFormatter } from "@mailwoman/core/fs/formatters"
import { pathExists, statPath } from "@mailwoman/core/fs/readers"
import { copyFileTo } from "@mailwoman/core/fs/writers"
import { dirname, resolvePath } from "path-ts"

import { resolvePackagePath, resolvePackageSpecifier } from "./workspace-resolution.ts"

//#region Model artifact staging

/**
 * Copy a file to the static directory, but only if it differs (by size) from what's already there.
 *
 * @param label - For logging
 *
 * @returns True if the file was copied
 */
export async function syncArtifact(sourcePath: string, destPath: string, label: string): Promise<boolean> {
	if (!(await pathExists(sourcePath))) {
		console.warn(`[demo-assets] ${label}: source missing at ${sourcePath}`)

		return false
	}

	const sourceSize = (await statPath(sourcePath)).size

	if (await pathExists(destPath)) {
		const destSize = (await statPath(destPath)).size

		if (sourceSize === destSize) return false
	}

	await copyFileTo(sourcePath, destPath)

	console.log(`[demo-assets] ${label}: synced (${ByteFormatter.formatIEC(sourceSize)})`)

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
export async function stageSQLJSHTTPVFS(destDir: string): Promise<boolean> {
	let distDir: string

	try {
		const entry = resolvePackageSpecifier("sql.js-httpvfs/dist/index.js")

		if (!entry) throw new Error("sql.js-httpvfs is not resolvable")
		distDir = dirname(entry)
	} catch {
		console.warn("[demo-assets] sql.js-httpvfs not resolvable — HTTP-VFS assets not staged")

		return false
	}

	const files = ["index.js", "sqlite.worker.js", "sql-wasm.wasm"]
	let copied = 0

	for (const f of files) {
		const src = resolvePath(distDir, f)

		if (!(await pathExists(src))) {
			console.warn(`[demo-assets] sql.js-httpvfs: missing ${f} in dist`)

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
		console.log(`[demo-assets] sql.js-httpvfs: staged ${copied} runtime asset(s)`)
	}

	return true
}

/**
 * Stage the placetype-pair indexes (placetype-pair-prior arc, #1278) SAME-ORIGIN into `destDir`
 * (`static/mailwoman/pair-index/`). Sources are `neural-weights-en-{gb,nz}/pair-index-{gb,nz}.bin`, materialized
 * locally by each package's `scripts/link-dev-weights.ts` (built from the register source CSV; not committed, like
 * model.onnx).
 *
 * DEV-PREVIEW ONLY since #1342 (2026-07-29): the demo reads the R2 bucket (`mailwoman/pair-index/<generation>/`,
 * versioned 2026-08-05 — see `resources.tsx`'s `PAIR_INDEX_VERSION`), so nothing fetches this same-origin copy at
 * runtime. It stays because it is the only way to see a locally-rebuilt index served by the site, and it costs ~1.5 MB
 * in the deploy.
 *
 * TOLERANT by design: a missing binary (a fresh worktree that never ran link-dev-weights, or a CI build with no dev
 * weights) is skipped with a warn — the demo loader fetches these with the same 404-tolerance, so an unstaged binary
 * just means that country's pair prior resolves OFF (byte-stable). `copyFileSync` dereferences a symlinked source, so
 * no symlink lands in the deploy.
 *
 * @param destDir - E.g. static/mailwoman/pair-index
 */
export async function stagePairIndexes(destDir: string): Promise<boolean> {
	const sources: Array<{ pkg: string; file: string }> = [
		{ pkg: "@mailwoman/neural-weights-en-gb", file: "pair-index-gb.bin" },
		{ pkg: "@mailwoman/neural-weights-en-nz", file: "pair-index-nz.bin" },
	]

	let copied = 0

	for (const { pkg, file } of sources) {
		const src = resolvePackagePath(pkg, file)

		if (!src) {
			console.warn(`[demo-assets] pair-index: ${pkg} not resolvable — ${file} not staged`)

			continue
		}

		if (!(await pathExists(src))) {
			console.warn(
				`[demo-assets] pair-index: ${file} missing at ${src} — not staged ` +
					`(run ${pkg}'s scripts/link-dev-weights.ts to build it; the demo tolerates its absence — that country's pair prior stays OFF).`
			)

			continue
		}

		const dest = resolvePath(destDir, file)

		// Idempotent stage (same reload-loop guard as stageSQLJSHTTPVFS): syncArtifact skips a size-identical copy.
		if (await syncArtifact(src, dest, `pair-index ${file}`)) {
			copied++
		}
	}

	if (copied > 0) {
		console.log(`[demo-assets] pair-index: staged ${copied} index binary/binaries`)
	}

	return true
}

//#endregion
