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
 *   Everything here resolves through `@mailwoman/core/module/resolve-from`, keyed on this file's `import.meta.url`,
 *   and nothing here touches `import.meta.resolve`: this file runs under Docusaurus's config loader, whose CommonJS
 *   transform rewrites `import.meta.url` and cannot parse `import.meta.resolve`, in this file or in anything it
 *   imports. Only a docs BUILD can verify a change to that, never a unit test.
 */

import { pathExists, readLocalTextFile } from "@mailwoman/core/fs/readers"
import { resolvePackagePathFrom, tryResolvePackageSpecifier } from "@mailwoman/core/module/resolve-from"
import { syncArtifact } from "@mailwoman/resolver-wof-wasm/host-assets"
import { basename, dirname, resolvePath } from "path-ts"

//#region Model artifact staging

/**
 * Relative imports of a staged ES module, from its `from "./…"` and `import "./…"` specifiers. A worker's siblings must
 * be staged beside it or the worker fails at its first import, which the browser reports nowhere useful.
 */
export function relativeImportSpecifiers(source: string): string[] {
	const specifiers = new Set<string>()

	for (const match of source.matchAll(/(?:from|import)\s*["'](\.\.?\/[^"']+)["']/g)) {
		specifiers.add(match[1]!)
	}

	return [...specifiers]
}

/**
 * Stage MapLibre's tile worker (`maplibre-gl-worker.mjs`) and the module it imports into `destDir`, and answer the
 * staged file names.
 *
 * MapLibre derives its default worker URL from `import.meta.url` and answers an EMPTY string when that is not an
 * `http(s):` URL. The docs client bundle is classic-script output, so webpack inlines `import.meta.url` as the `file:`
 * path of `maplibre-gl.mjs` on the build host; the empty URL then spawns the PAGE ITSELF as the worker, which dies at
 * its first byte of HTML. No error reaches the console, `map.loaded()` stays false, and no tile is ever requested. The
 * demo sets `setWorkerUrl` to the staged copy (`docs/src/shared/maplibre-worker.ts`), which is same-origin and
 * therefore loads as a module worker.
 *
 * Staging from the installed package, at build time, is what keeps the worker at the same version as the bundled main
 * thread; a committed copy would drift on the next dependency bump.
 *
 * @param destDir - E.g. static/mailwoman/maplibre
 */
export async function stageMapLibreWorker(destDir: string): Promise<string[]> {
	const workerPath = tryResolvePackageSpecifier(import.meta.url, "maplibre-gl", "dist/maplibre-gl-worker.mjs")

	if (!workerPath) {
		console.warn("[demo-assets] maplibre-gl worker not resolvable — MapLibre worker not staged")

		return []
	}

	const distDir = dirname(workerPath)
	const workerSource = await readLocalTextFile(workerPath)

	const files = [
		basename(workerPath),
		...relativeImportSpecifiers(workerSource).map((specifier) => basename(specifier)),
	]

	const staged: string[] = []
	let copied = 0

	for (const file of files) {
		const src = resolvePath(distDir, file)

		if (!(await pathExists(src))) {
			throw new Error(`[demo-assets] maplibre-gl worker imports ${file}, which is missing from ${distDir}`)
		}

		// Idempotent stage (same reload-loop guard as stageSQLJSHTTPVFS): syncArtifact skips a size-identical copy.
		if (await syncArtifact(src, resolvePath(destDir, file), `maplibre-gl ${file}`)) {
			copied++
		}

		staged.push(file)
	}

	if (copied > 0) {
		console.log(`[demo-assets] maplibre-gl: staged ${copied} worker asset(s)`)
	}

	return staged
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
		const src = resolvePackagePathFrom(import.meta.url, pkg, file)

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
