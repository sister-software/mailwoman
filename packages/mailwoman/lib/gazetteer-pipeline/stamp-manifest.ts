/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Writes a `layer_manifest` into a freshly built database. Call it before `sealDatabase`, because a
 *   sealed database is read-only.
 */

import {
	createLayerManifestTable,
	type layerschemadatabase,
	type LayerManifest,
	writeLayerManifest,
} from "@mailwoman/core/layers"
import { runFileSync } from "@mailwoman/core/process"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import type { PathBuilderLike } from "path-ts"

/**
 * Opens `path`, writes `manifest` into it, and closes the connection.
 *
 * The function opens its own connection.
 * Callers reach it after closing their build handle and before sealing the database.
 *
 * @throws When the database is already sealed.
 */
export async function stampLayerManifest(path: PathBuilderLike, manifest: LayerManifest): Promise<void> {
	using kdb = new DatabaseClient<layerschemadatabase>(path)

	await createLayerManifestTable(kdb)
	await writeLayerManifest(kdb, manifest)
}

/**
 * Returns the short git SHA of `repoRoot` for `layer_manifest.build_sha`.
 *
 * It returns `unknown` when git fails, so a build outside a checkout still gets a manifest.
 */
export function buildSHA(repoRoot: PathBuilderLike): string {
	try {
		return runFileSync("git", ["rev-parse", "--short", "HEAD"], {
			cwd: repoRoot,
			encoding: "utf8",
			stdio: "pipe",
		}).trim()
	} catch {
		return "unknown"
	}
}
