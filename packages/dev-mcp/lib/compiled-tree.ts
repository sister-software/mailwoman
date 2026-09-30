/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Refuse to run a compiled tree that predates its source.
 *
 *   This server imports source, so `out/` is normally absent from its import path (see `tree-fingerprint.ts`).
 *   The gauntlet writes its full report to stdout. Here stdout is reserved for JSON-RPC messages, so running the gauntlet
 *   in-process would corrupt the transport. The server spawns `out/cli/main.js`, which makes stale compiled files
 *   relevant.
 *
 *   A stale compiled tree can load a deleted case array, write a database, print "built", and exit with status 0.
 *   Later evals then grade a corpus absent from the artifact. The guard refuses that tree because a warning would leave
 *   misleading successful build output in place.
 *
 *   `@mailwoman/core/module/compiled-freshness` compares the newest source with the newest emit. It excludes
 *   `out/*.d.ts` and the test tree. The promotion battery uses the same check. Its previous copy compared source
 *   mtimes with the `out/` directory. `tsc` does not advance that directory's timestamp when it overwrites files in place.
 *   This module defines the workspace set because that set depends on what this server spawns.
 */

import { checkCompiledFreshness, type CompiledFreshness } from "@mailwoman/core/module/compiled-freshness"
import type { PathBuilderLike } from "path-ts"

import { FINGERPRINTED_WORKSPACES } from "#tree-fingerprint"

/**
 * Whether the compiled tree a spawned CLI will load is newer than the source it was emitted from.
 */
export async function checkSpawnedTreeFreshness(repoRoot: PathBuilderLike): Promise<CompiledFreshness> {
	return await checkCompiledFreshness(repoRoot, FINGERPRINTED_WORKSPACES)
}

/**
 * @throws When the compiled tree predates its source.
 */
export async function assertCompiledFresh(repoRoot: PathBuilderLike): Promise<CompiledFreshness> {
	const freshness = await checkSpawnedTreeFreshness(repoRoot)

	if (!freshness.fresh) {
		throw new Error(
			`${freshness.reason!} The gauntlet runs the COMPILED tree, so it would grade code you have replaced — and it ` +
				"would report a verdict rather than an error."
		)
	}

	return freshness
}
