/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build-time utilities for the runtime-assets plugin, running in Node.js only (Docusaurus config/plugin context) and never bundled into the client.
 *
 *   Everything here resolves through `@mailwoman/core/module/resolve-from` keyed on this file's `import.meta.url`, and no code touches `import.meta.resolve`, because Docusaurus's CommonJS transform rewrites the former and cannot parse the latter; only a docs build can verify a change to that.
 */

import { pathExists, readLocalTextFile } from "@mailwoman/core/fs/readers"
import { tryResolvePackageSpecifier } from "@mailwoman/core/module/resolve-from"
import { syncArtifact } from "@mailwoman/resolver-wof-wasm/host-assets"
import { basename, dirname, type PathBuilderLike, resolvePath } from "path-ts"

// #region Model artifact staging

/**
 * Relative imports of a staged ES module, whose siblings must be staged beside it
 * or the worker fails at its first import with no useful browser error.
 */
export function relativeImportSpecifiers(source: string): string[] {
	const specifiers = new Set<string>()

	for (const match of source.matchAll(/(?:from|import)\s*["'](\.\.?\/[^"']+)["']/g)) {
		specifiers.add(match[1]!)
	}

	return [...specifiers]
}

/**
 * Stage MapLibre's tile worker and the module it imports into `destDir`,
 * at the same version as the bundled main thread.
 *
 * The docs client bundle inlines `import.meta.url` as a host `file:` path, so MapLibre's
 * derived worker URL is empty and the page would otherwise spawn itself as the worker and die
 * silently at its first byte of html; the site points `setWorkerUrl` at the staged copy instead.
 *
 * @param destDir - E.g. static/mailwoman/maplibre
 */
export async function stageMapLibreWorker(destDir: PathBuilderLike): Promise<string[]> {
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

		// `syncArtifact` skips a size-identical copy, so this stage is idempotent.
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

// #endregion
