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

import { parseJSONStrict } from "@mailwoman/core/objects"
import { spawnSync } from "@mailwoman/platform/child_process"
import { copyFileSync, lstatSync, readFileSync, readlinkSync, unlinkSync, writeFileSync } from "@mailwoman/platform/fs"
import { dirname, resolve } from "@mailwoman/platform/path"

import { assertNoSourceTargets, transformExportsForPublish, transformImportsForPublish } from "./publish-exports.ts"

/**
 * Replace any symlinked `files` entries with real copies of their targets. `yarn pack` stores symlinks AS symlinks in
 * the tarball — the registry rejects those outright (YN0035 / HTTP 415), and npm's local-tarball extraction handles
 * them no better, so a smoke install of a packed weights workspace whose `model.onnx` is a `link-dev-weights` symlink
 * breaks the same way. Single-sourced here (2026-07-23) so BOTH pack callers get it: `publish-workspace.ts` keeps its
 * own pre-pack invocation as the documented safety net (see AGENTS.md "symlinks in the publish tarball"), and
 * `smoke-clean-install.ts` inherits it through `packWorkspaceForPublish` below.
 */
export function dereferenceWorkspaceSymlinks(workspaceDir: string): void {
	const pkg = parseJSONStrict<{ files?: unknown[] }>(readFileSync(resolve(workspaceDir, "package.json"), "utf8"))

	for (const entry of pkg.files ?? []) {
		if (typeof entry !== "string" || /[*?[{]/.test(entry)) continue // skip globs
		const target = resolve(workspaceDir, entry)
		const st = lstatSync(target, { throwIfNoEntry: false })

		if (!st?.isSymbolicLink()) continue
		const linkDest = readlinkSync(target)
		const resolved = resolve(dirname(target), linkDest)
		unlinkSync(target)
		copyFileSync(resolved, target)

		console.error(`pack-workspace: dereferenced ${entry} ← ${resolved}`)
	}
}

/**
 * Pack `workspaceDir` into `outFile` with the derived publish map substituted. Throws on pack failure. The workspace
 * manifest is byte-restored even on failure. Symlinked `files` entries are dereferenced first (see
 * {@link dereferenceWorkspaceSymlinks}).
 */
export function packWorkspaceForPublish(workspaceDir: string, outFile: string): void {
	const manifestPath = resolve(workspaceDir, "package.json")
	const originalManifest = readFileSync(manifestPath, "utf8")

	dereferenceWorkspaceSymlinks(workspaceDir)

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

			writeFileSync(manifestPath, JSON.stringify(manifest, null, "\t") + "\n")
		}

		const result = spawnSync("yarn", ["pack", "-o", outFile], { cwd: workspaceDir, stdio: ["ignore", "pipe", "pipe"] })

		if (result.status !== 0) {
			throw new Error(`pack-workspace: yarn pack failed for ${workspaceDir} (exit ${result.status}): ${result.stderr}`)
		}
	} finally {
		writeFileSync(manifestPath, originalManifest)
	}
}
