/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Write a `layer_manifest` into a freshly built database — the one place every builder does it.
 *
 *   Phase 3 of the lab-reproducibility sequence rolls the layer contract out across the builders
 *   `mailwoman data inventory` reported as unprovenanced. Four of them would otherwise repeat the same
 *   twenty-five lines of open/create/write/destroy, which is the shape AGENTS.md names a defect generator:
 *   the code gets copied correctly and the reasoning does not travel with it.
 *
 *   THE ORDERING IS THE WHOLE CONTRACT. This must run BEFORE `sealDatabase`, because a sealed artifact is
 *   `0444` and a manifest written afterwards needs the database reopened read-write — the one thing
 *   `openBuiltDatabase` exists to refuse. Calling it after the seal does not fail quietly; it fails
 *   loudly, which is the correct half. What it would cost is the build, at its very end.
 */

import { DatabaseClient } from "@mailwoman/core/kysley/client"
import {
	createLayerManifestTable,
	type LayerContractDatabase,
	type LayerManifest,
	writeLayerManifest,
} from "@mailwoman/core/layers"
import { execFileSync } from "@mailwoman/platform/child_process"
import { DatabaseSync } from "@mailwoman/platform/sqlite"

/**
 * Open `path`, write `manifest`, and close.
 *
 * Opens its own connection rather than taking the builder's: every caller reaches this point after its own handle is
 * closed and before the seal, and threading a live handle through would make the ordering above depend on each
 * builder's cleanup rather than on this function.
 *
 * @throws When the database is already sealed, which is the ordering mistake this function exists to make loud.
 */
export async function stampLayerManifest(path: string, manifest: LayerManifest): Promise<void> {
	const db = new DatabaseSync(path)
	const kdb = new DatabaseClient<LayerContractDatabase>(db)

	try {
		await createLayerManifestTable(kdb)
		await writeLayerManifest(kdb, manifest)
	} finally {
		await kdb.destroy()
	}
}

/**
 * The git sha of the tree that ran a build, for `layer_manifest.build_sha`.
 *
 * Degrades to `unknown` rather than throwing. A build run outside a checkout — a container, an unpacked tarball — is a
 * legitimate build, and refusing to stamp a manifest over a missing git binary would leave the artifact with NO
 * provenance at all, which is the state this phase exists to reduce.
 */
export function buildSHA(repoRoot: string): string {
	try {
		return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
			cwd: repoRoot,
			encoding: "utf8",
			stdio: "pipe",
		}).trim()
	} catch {
		return "unknown"
	}
}
