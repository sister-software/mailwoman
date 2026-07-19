/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The ONE way to produce a consumer-grade tarball from a workspace: inject the derived
 *   `publishConfig.exports` (strip `node → .ts` — Node refuses type-stripping under
 *   node_modules, so that condition must never reach a consumer), `yarn pack`, restore the
 *   manifest. Used by BOTH the release path (`publish-workspace.ts`) and the CI smoke test
 *   (`smoke-clean-install.ts`) — the smoke previously packed raw and shipped dev maps, which
 *   let the v7.2.0 ship-break class through untested.
 */

import { spawnSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

import { transformExportsForPublish } from "./publish-exports.ts"

/**
 * Pack `workspaceDir` into `outFile` with the derived publish map substituted. Throws on pack failure. The workspace
 * manifest is byte-restored even on failure.
 */
export function packWorkspaceForPublish(workspaceDir: string, outFile: string): void {
	const manifestPath = resolve(workspaceDir, "package.json")
	const originalManifest = readFileSync(manifestPath, "utf8")

	try {
		const manifest = JSON.parse(originalManifest)

		if (manifest.exports) {
			manifest.publishConfig = {
				...manifest.publishConfig,
				exports: transformExportsForPublish(manifest.exports),
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
