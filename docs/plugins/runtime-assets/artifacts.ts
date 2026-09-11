/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build-time utilities for the runtime-assets plugin. Resolves workspace packages and their
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
import { tryResolvePackageSpecifier } from "@mailwoman/core/module/resolve-from"
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
 * site sets `setWorkerUrl` to the staged copy (`docs/src/shared/maplibre/worker/index.ts`), which is same-origin and
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
		console.warn("[runtime-assets] maplibre-gl worker not resolvable — MapLibre worker not staged")

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
			throw new Error(`[runtime-assets] maplibre-gl worker imports ${file}, which is missing from ${distDir}`)
		}

		// Idempotent stage (same reload-loop guard as stageSQLJSHTTPVFS): syncArtifact skips a size-identical copy.
		if (await syncArtifact(src, resolvePath(destDir, file), `maplibre-gl ${file}`)) {
			copied++
		}

		staged.push(file)
	}

	if (copied > 0) {
		console.log(`[runtime-assets] maplibre-gl: staged ${copied} worker asset(s)`)
	}

	return staged
}

//#endregion
