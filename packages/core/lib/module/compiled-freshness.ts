/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Whether a workspace's `out/` predates the source it was emitted from.
 *
 *   Anything that spawns or imports the COMPILED tree needs this, and the failure mode is silence: a stale `out/`
 *   produces a verdict rather than an error. Two callers had their own copy and they did not agree — the dev-MCP's
 *   refused correctly, and the promotion battery's compared every source against the mtime of the `out/` DIRECTORY.
 *
 *   A directory's mtime moves when an entry is added or removed. `tsc` overwrites existing files in place, so after a
 *   recompile that emits no new filenames the directory keeps the mtime of the last file creation while every `.js`
 *   inside it is current. Measured on `packages/core` at 2026-09-19: the directory read `2026-09-14T17:36:04Z` against
 *   a newest emit of `2026-09-19T02:33:12Z`, so the battery warned after every successful compile and separated
 *   nothing. The reference here is the newest EMITTED FILE.
 *
 *   The second trap is what counts as source. An emitted `.d.ts` sits under `out/` and ends in `.ts`, so a glob that
 *   takes it as source compares the emit against itself and the check can never be satisfied. Excluded by extension
 *   and by path.
 */

import { basename, join, relative, sep } from "path-ts"
import { Globerator } from "spliterator/node/fs"

import { statPath } from "#fs/readers"

/**
 * Directories that hold no emitting source and would cost a full walk.
 */
const SKIP_DIRECTORIES = new Set(["node_modules", ".git", "__pycache__"])

/**
 * One file and when it changed.
 */
export interface TimestampedFile {
	mtimeMs: number
	path: string
}

/**
 * Whether a TypeScript source can contribute to a workspace's compiled output. Mirrors the workspace tsconfig
 * exclusions without treating every directory named `test` as non-emitting: production modules such as
 * `debug-view/test/input-probe.ts` compile and must still make the check stale.
 */
function isEmittingSource(workspaceRoot: string, path: string): boolean {
	const name = basename(path)

	if (/\.test\.tsx?$/.test(name)) return false

	const [firstSegment] = relative(workspaceRoot, path).split(sep)

	return firstSegment !== "test"
}

/**
 * Newest mtime under a directory, restricted to files matching a predicate. Answers `null` when the directory does not
 * exist, which a caller must tell apart from "old" — a missing `out/` means never compiled rather than stale.
 */
async function newestMtime(
	root: string,
	matches: (name: string) => boolean,
	pathAllowed: (path: string) => boolean = () => true
): Promise<TimestampedFile | null> {
	let newest: TimestampedFile | null = null
	const stack = [root]

	while (stack.length) {
		const directory = stack.pop()!
		let entries

		try {
			entries = await Globerator.from("*", { cwd: directory, withFileTypes: true, onlyFiles: false }).toArray()
		} catch {
			continue
		}

		for (const entry of entries) {
			if (entry.isDirectory()) {
				if (!SKIP_DIRECTORIES.has(entry.name)) {
					stack.push(join(directory, entry.name))
				}

				continue
			}

			if (!matches(entry.name)) continue

			const full = join(directory, entry.name)

			if (!pathAllowed(full)) continue

			const { mtimeMs } = await statPath(full)

			if (!newest || mtimeMs > newest.mtimeMs) {
				newest = { mtimeMs, path: full }
			}
		}
	}

	return newest
}

/**
 * The reading, with both endpoints so a caller can report which files decided it.
 */
export interface CompiledFreshness {
	fresh: boolean
	newestSource: TimestampedFile | null
	newestCompiled: TimestampedFile | null
	/**
	 * Why it is not fresh, or `null` when it is. Written as the action, because that is what the reader needs.
	 */
	reason: string | null
}

/**
 * Compare the newest source file against the newest compiled output across the named workspaces.
 *
 * `workspaces` are repo-relative directories, and each caller states its own set: the dev-MCP names the workspaces a
 * spawned CLI will load, while a battery names the ones its harness imports. A caller that names too few gets a `fresh`
 * it has not earned, so the set belongs with the caller that knows what it loads.
 */
export async function checkCompiledFreshness(
	repoRoot: string,
	workspaces: readonly string[]
): Promise<CompiledFreshness> {
	let newestSource: TimestampedFile | null = null
	let newestCompiled: TimestampedFile | null = null

	for (const workspace of workspaces) {
		const workspaceRoot = join(repoRoot, workspace)

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
			reason: "No compiled output found. Run `yarn compile` first.",
		}
	}

	if (newestSource && newestSource.mtimeMs > newestCompiled.mtimeMs) {
		const driftSeconds = Math.round((newestSource.mtimeMs - newestCompiled.mtimeMs) / 1000)

		return {
			fresh: false,
			newestSource,
			newestCompiled,
			reason:
				`Compiled output is ${driftSeconds}s older than source: ${newestSource.path} was modified after ` +
				`${newestCompiled.path}. Run \`yarn compile\` and re-run.`,
		}
	}

	return { fresh: true, newestSource, newestCompiled, reason: null }
}
