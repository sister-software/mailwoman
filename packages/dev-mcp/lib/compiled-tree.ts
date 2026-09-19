/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Refuse to run a compiled tree that predates its source.
 *
 *   This server imports source, so `out/` is normally not on its path at all (see `tree-fingerprint.ts`). One thing
 *   re-opens it: the gauntlet writes its whole report to stdout, and stdout here is the JSON-RPC channel — running it
 *   in-process would corrupt the transport. So it is spawned as `out/cli.js`, which puts the stale-`out/` trap back on
 *   the table, and this is the answer to it.
 *
 *   The trap is not hypothetical. `corpus-stamp.ts` records 2026-08-06: `eval gauntlet-build regression-db` ran from a
 *   compiled tree whose `out/` loader still held a deleted case array, wrote a database, printed "built", exited 0, and
 *   every eval afterwards graded a corpus nobody had. The failure mode is silence, so the answer here is a refusal
 *   rather than a warning.
 *
 *   The RULE — newest source against newest emit, with `out/*.d.ts` and the test tree excluded — lives in
 *   `@mailwoman/core/module/compiled-freshness`, because the promotion battery needs the same one and its own copy
 *   disagreed: it compared sources against the mtime of the `out/` DIRECTORY, which `tsc` never advances when it
 *   overwrites in place. What stays here is the workspace SET, which is a property of what this server spawns.
 */

import { checkCompiledFreshness, type CompiledFreshness } from "@mailwoman/core/module/compiled-freshness"

import { FINGERPRINTED_WORKSPACES } from "#tree-fingerprint"

/**
 * Whether the compiled tree a spawned CLI will load is newer than the source it was emitted from.
 */
export async function checkSpawnedTreeFreshness(repoRoot: string): Promise<CompiledFreshness> {
	return await checkCompiledFreshness(repoRoot, FINGERPRINTED_WORKSPACES)
}

/**
 * @throws When the compiled tree predates its source.
 */
export async function assertCompiledFresh(repoRoot: string): Promise<CompiledFreshness> {
	const freshness = await checkSpawnedTreeFreshness(repoRoot)

	if (!freshness.fresh) {
		throw new Error(
			`${freshness.reason!} The gauntlet runs the COMPILED tree, so it would grade code you have replaced — and it ` +
				"would report a verdict rather than an error."
		)
	}

	return freshness
}
