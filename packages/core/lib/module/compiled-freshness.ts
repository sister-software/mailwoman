/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Checks whether a workspace's compiled `out/` tree is older than its source.
 *
 *   The check compares against the newest emitted `.js` file. The `out/` directory's own mtime is unreliable because
 *   `tsc` overwrites files in place, and the directory mtime changes only when an entry is added or removed.
 *
 *   Emitted `.d.ts` files end in `.ts` and live under `out/`, so the source scan excludes them by extension and by path.
 *   Otherwise the emit would be compared against itself.
 */

import { basename, PathBuilder, type PathBuilderLike, relative, sep } from "path-ts"
import { Globerator } from "spliterator/node/fs"

import { statPath } from "#fs/readers"

/**
 * The walk skips these directories because they hold no emitting source.
 */
const SKIP_DIRECTORIES = new Set(["node_modules", ".git", "__pycache__"])

/**
 * A file path with its modification time in milliseconds.
 */
export interface TimestampedFile {
	mtimeMs: number
	path: string
}

/**
 * Reports whether a TypeScript source file contributes to a workspace's compiled output.
 *
 * The function mirrors the workspace tsconfig exclusions.
 * It excludes `*.test.ts(x)` files and the top-level `test/` directory only.
 *
 * Nested `test` directories such as `debug-view/test/` hold production modules that compile.
 */
function isEmittingSource(workspaceRoot: PathBuilder, path: string): boolean {
	const name = basename(path)

	if (/\.test\.tsx?$/.test(name)) return false

	const [firstSegment] = relative(workspaceRoot, path).split(sep)

	return firstSegment !== "test"
}

/**
 * Finds the most recently modified file under a directory that passes both predicates.
 *
 * The function returns `null` when the directory is missing or holds no matching file.
 * For `out/`, that result means the workspace was never compiled.
 */
async function newestMtime(
	root: PathBuilder,
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
					stack.push(directory(entry.name))
				}

				continue
			}

			if (!matches(entry.name)) continue

			const full = directory(entry.name).toString()

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
 * The freshness result, with the newest source and compiled files so a caller
 * can report which files decided it.
 */
export interface CompiledFreshness {
	fresh: boolean
	newestSource: TimestampedFile | null
	newestCompiled: TimestampedFile | null
	/**
	 * A message that tells the reader what to run, or `null` when the output is fresh.
	 */
	reason: string | null
}

/**
 * Compares the newest source file against the newest compiled `.js` file across the given workspaces.
 *
 * `workspaces` are repo-relative directories.
 * Each caller passes the workspaces it actually loads.
 *
 * A set that omits a loaded workspace can report `fresh` while that workspace is stale.
 */
export async function checkCompiledFreshness(
	repoRoot: PathBuilderLike,
	workspaces: readonly string[]
): Promise<CompiledFreshness> {
	let newestSource: TimestampedFile | null = null
	let newestCompiled: TimestampedFile | null = null

	const root = PathBuilder.from(repoRoot)

	for (const workspace of workspaces) {
		const workspaceRoot = root(workspace)

		const [source, compiled] = await Promise.all([
			newestMtime(
				workspaceRoot,
				(name) => /\.tsx?$/.test(name) && !name.endsWith(".d.ts"),
				(path) => !path.includes(`${workspace}/out/`) && isEmittingSource(workspaceRoot, path)
			),
			newestMtime(workspaceRoot("out"), (name) => name.endsWith(".js")),
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
