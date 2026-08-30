/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Refuse to run a compiled tree that predates its source.
 *
 *   This server imports SOURCE, so `out/` is normally not on its path at all (see `tree-fingerprint.ts`). One thing
 *   re-opens it: the gauntlet writes its whole report to stdout, and stdout here is the JSON-RPC channel — running it
 *   in-process would corrupt the transport. So it is spawned as `out/cli.js`, which puts the stale-`out/` trap back on
 *   the table, and this is the answer to it.
 *
 *   The trap is not hypothetical. `corpus-stamp.ts` records 2026-08-06: `eval gauntlet-build regression-db` ran from a
 *   compiled tree whose `out/` loader still held a deleted case array, wrote a database, printed "built", exited 0, and
 *   every gate afterwards graded a corpus nobody had. `promotion-gate.ts` carries its own recompile-before-eval guard
 *   for the same reason. The failure mode is silence, so the answer is a refusal rather than a warning.
 */

import { readDirectoryEntries, statPath } from "@mailwoman/core/fs/readers"
import { basename, join, relative, sep } from "@mailwoman/platform/path"

import { FINGERPRINTED_WORKSPACES } from "./tree-fingerprint.ts"

const SKIP_DIRECTORIES = new Set(["node_modules", ".git", "__pycache__"])

/**
 * Whether a TypeScript source can contribute to a workspace's compiled output. Mirrors the workspace tsconfig
 * exclusions without treating every directory named `test` as non-emitting: production modules such as
 * `debug-view/test/input-probe.ts` compile and must still make the guard stale.
 */
function isEmittingSource(workspaceRoot: string, path: string): boolean {
	const name = basename(path)

	if (/\.test\.tsx?$/.test(name)) return false

	const [firstSegment] = relative(workspaceRoot, path).split(sep)

	return firstSegment !== "test"
}

/**
 * Newest mtime under a directory, restricted to files matching a predicate. Returns `null` when the directory does not
 * exist, which a caller must distinguish from "old" — a missing `out/` means never compiled, not stale.
 */
async function newestMtime(
	root: string,
	matches: (name: string) => boolean,
	pathAllowed: (path: string) => boolean = () => true
): Promise<{ mtimeMs: number; path: string } | null> {
	let newest: { mtimeMs: number; path: string } | null = null
	const stack = [root]

	while (stack.length) {
		const dir = stack.pop()!
		let entries

		try {
			entries = await readDirectoryEntries(dir)
		} catch {
			continue
		}

		for (const entry of entries) {
			if (entry.isDirectory()) {
				if (!SKIP_DIRECTORIES.has(entry.name)) {
					stack.push(join(dir, entry.name))
				}

				continue
			}

			if (!matches(entry.name)) continue

			const full = join(dir, entry.name)

			if (!pathAllowed(full)) continue

			const { mtimeMs } = await statPath(full)

			if (!newest || mtimeMs > newest.mtimeMs) {
				newest = { mtimeMs, path: full }
			}
		}
	}

	return newest
}

export interface CompiledFreshness {
	fresh: boolean
	newestSource: { mtimeMs: number; path: string } | null
	newestCompiled: { mtimeMs: number; path: string } | null
	/**
	 * Why it is not fresh, or `null` when it is. Written as the remedy, because that is what the reader needs.
	 */
	reason: string | null
}

/**
 * Compare the newest source file against the newest compiled output across the workspaces a spawned CLI will load.
 */
export async function checkCompiledFreshness(repoRoot: string): Promise<CompiledFreshness> {
	let newestSource: { mtimeMs: number; path: string } | null = null
	let newestCompiled: { mtimeMs: number; path: string } | null = null

	for (const workspace of FINGERPRINTED_WORKSPACES) {
		const workspaceRoot = join(repoRoot, workspace)

		// Emitted `.d.ts` files live under out/ and are newer than everything by construction, so counting them as
		// source would make the guard permanently unsatisfiable. Excluded by extension AND by path.
		const [source, compiled] = await Promise.all([
			newestMtime(
				workspaceRoot,
				(name) => /\.tsx?$/.test(name) && !name.endsWith(".d.ts"),
				(path) => !path.includes(`${workspace}/out/`) && isEmittingSource(workspaceRoot, path)
			),
			newestMtime(join(workspaceRoot, "out"), (name) => name.endsWith(".js")),
		])

		if (source && (!newestSource || source.mtimeMs > newestSource.mtimeMs)) {
			newestSource = source
		}

		if (compiled && (!newestCompiled || compiled.mtimeMs > newestCompiled.mtimeMs)) {
			newestCompiled = compiled
		}
	}

	if (!newestCompiled) {
		return {
			fresh: false,
			newestSource,
			newestCompiled: null,
			reason: "No compiled output found. Run `yarn compile` before running the gauntlet.",
		}
	}

	if (newestSource && newestSource.mtimeMs > newestCompiled.mtimeMs) {
		const drift = Math.round((newestSource.mtimeMs - newestCompiled.mtimeMs) / 1000)

		return {
			fresh: false,
			newestSource,
			newestCompiled,
			reason:
				`Compiled output is ${drift}s older than source: ${newestSource.path} was modified after ` +
				`${newestCompiled.path}. The gauntlet runs the COMPILED tree, so it would grade code you have replaced — ` +
				"and it would report a verdict rather than an error. Run `yarn compile` and re-run.",
		}
	}

	return { fresh: true, newestSource, newestCompiled, reason: null }
}

/**
 * @throws When the compiled tree predates its source.
 */
export async function assertCompiledFresh(repoRoot: string): Promise<CompiledFreshness> {
	const freshness = await checkCompiledFreshness(repoRoot)

	if (!freshness.fresh) throw new Error(freshness.reason!)

	return freshness
}
