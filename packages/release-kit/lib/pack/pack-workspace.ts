/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The ONE way to produce a consumer-grade tarball from a workspace: inject the derived
 *   `publishConfig.exports` (rewrite every `.ts` target to emitted JavaScript — Node refuses
 *   type-stripping under node_modules, so a source target must never reach a consumer), refuse the pack outright if
 *   one survives, `yarn pack`, restore the manifest. Used by BOTH the release path (`publish-workspace.ts`) and the CI smoke test
 *   (`smoke-clean-install.ts`) — the smoke previously packed raw and shipped dev maps, which
 *   let the v7.2.0 ship-break class through untested.
 */

import { readLink, readLocalJSONFile, readLocalTextFile, tryStatLink } from "@mailwoman/core/fs/readers"
import { copyFileTo, removePath, writeLocalFile, writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { parseJSONStrict } from "@mailwoman/core/objects"
import { spawnProcessSync } from "@mailwoman/core/process"
import { dirname, resolvePath } from "path-ts"

import { assertNoSourceTargets, transformExportsForPublish, transformImportsForPublish } from "#pack/publish-exports"

/**
 * Replace any symlinked `files` entries with real copies of their targets. `yarn pack` stores symlinks AS symlinks in
 * the tarball — the registry rejects those outright (YN0035 / HTTP 415), and npm's local-tarball extraction handles
 * them no better, so a smoke install of a packed weights workspace whose `model.onnx` is a `link-dev-weights` symlink
 * breaks the same way. Single-sourced here (2026-07-23) so BOTH pack callers get it: `publish-workspace.ts` keeps its
 * own pre-pack invocation as the documented safety net (see AGENTS.md "symlinks in the publish tarball"), and
 * `smoke-clean-install.ts` inherits it through `packWorkspaceForPublish` below.
 */
export async function dereferenceWorkspaceSymlinks(workspaceDir: string): Promise<void> {
	const pkg = await readLocalJSONFile<{ files?: unknown[] }>(resolvePath(workspaceDir, "package.json"))

	for (const entry of pkg.files ?? []) {
		if (typeof entry !== "string" || /[*?[{]/.test(entry)) continue // skip globs
		const target = resolvePath(workspaceDir, entry)
		const st = await tryStatLink(target)

		if (!st?.isSymbolicLink()) continue
		const linkDest = await readLink(target)
		const resolved = resolvePath(dirname(target), linkDest)
		await removePath(target)
		await copyFileTo(resolved, target)

		console.error(`pack-workspace: dereferenced ${entry} ← ${resolved}`)
	}
}

/**
 * Pack `workspaceDir` into `outFile` with the derived publish map substituted. Throws on pack failure. The workspace
 * manifest is byte-restored even on failure. Symlinked `files` entries are dereferenced first (see
 * {@link dereferenceWorkspaceSymlinks}).
 */
export async function packWorkspaceForPublish(workspaceDir: string, outFile: string): Promise<void> {
	const manifestPath = resolvePath(workspaceDir, "package.json")
	const originalManifest = await readLocalTextFile(manifestPath)

	await dereferenceWorkspaceSymlinks(workspaceDir)

	try {
		const manifest = parseJSONStrict<{
			exports?: unknown
			imports?: unknown
			publishConfig?: Record<string, unknown>
		}>(originalManifest)

		if (manifest.exports || manifest.imports) {
			const exports = manifest.exports ? transformExportsForPublish(manifest.exports) : undefined
			const imports = manifest.imports ? transformImportsForPublish(manifest.imports) : undefined

			assertNoSourceTargets(`${workspaceDir} exports`, exports)
			assertNoSourceTargets(`${workspaceDir} imports`, imports)

			manifest.publishConfig = {
				...manifest.publishConfig,
				...(exports ? { exports } : {}),
				...(imports ? { imports } : {}),
			}

			await writeLocalJSONFile(manifest, manifestPath)
		}

		const result = spawnProcessSync("yarn", ["pack", "-o", outFile], {
			cwd: workspaceDir,
			stdio: ["ignore", "pipe", "pipe"],
		})

		if (result.status !== 0) {
			throw new Error(`pack-workspace: yarn pack failed for ${workspaceDir} (exit ${result.status}): ${result.stderr}`)
		}
	} finally {
		await writeLocalFile(originalManifest, manifestPath)
	}
}
