/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The tracked-source enumerator the repository sweeps share.
 *
 *   Enumerated from the INDEX, not the filesystem. A file set read off the disk is not a property of
 *   the repository — it is a property of whichever files happen to be sitting in that checkout. A
 *   tree carrying gitignored scratch scripts under `scripts/diagnostic/` counted 166 `asNever`
 *   against a clean checkout's 85 at the SAME commit, so the debt check failed on files no commit
 *   contains; a directory walk likewise kept flagging `scratchpad/` probes and agent worktrees —
 *   hits that fail for whoever has the file and CANNOT fail in CI, which reads as a real violation
 *   and is unreproducible by the person asked to fix it. `git ls-files` answers the actual question,
 *   and drops the hand-maintained skip lists (build output, `node_modules`, `.yarn`) with it: two
 *   readers of the same count must be able to reproduce each other.
 */

import { pathExists } from "@mailwoman/core/fs/readers"
import { isPresent } from "@mailwoman/core/objects"
import { runFile } from "@mailwoman/core/process"
import { resolvePath } from "path-ts"

export interface TrackedSourceOptions {
	/**
	 * Pathspecs handed to `git ls-files` (default: every `.ts` / `.tsx`).
	 */
	globs?: readonly string[]
	/**
	 * Keep only paths under this repo-relative prefix (e.g. `"packages/"`).
	 */
	prefix?: string
	/**
	 * Repo-relative prefixes to drop — each call site states its reason beside the list it passes.
	 */
	excludePrefixes?: readonly string[]
	/**
	 * Keep `.d.ts` files. Off by default: declarations are outputs, not sources.
	 */
	includeDeclarations?: boolean
	/**
	 * Drop tracked paths absent from the working tree (a deletion staged but not committed), so a sweep never fails on a
	 * file the next commit removes anyway.
	 */
	existingOnly?: boolean
}

/**
 * The TRACKED sources under `root`, as absolute paths in `git ls-files` order.
 *
 * `out/` and `node_modules/` path segments are always dropped: the index can carry a stray build artifact, and no sweep
 * means to read one.
 */
export async function trackedSourcePaths(root: string, options: TrackedSourceOptions = {}): Promise<string[]> {
	const { prefix, excludePrefixes } = options
	const globs = options.globs ?? ["*.ts", "*.tsx"]

	const { stdout } = await runFile("git", ["ls-files", "-z", "--", ...globs], {
		cwd: root,
		maxBuffer: 64 * 1024 * 1024,
	})

	let paths = stdout
		.split("\0")
		.filter((relativePath) => relativePath.length > 0)
		.filter((relativePath) => !/(?:^|\/)(?:out|node_modules)\//.test(relativePath))

	if (prefix) {
		paths = paths.filter((relativePath) => relativePath.startsWith(prefix))
	}

	if (excludePrefixes?.length) {
		paths = paths.filter((relativePath) => !excludePrefixes.some((excluded) => relativePath.startsWith(excluded)))
	}

	if (!options.includeDeclarations) {
		paths = paths.filter((relativePath) => !relativePath.endsWith(".d.ts"))
	}

	const absolute = paths.map((relativePath) => resolvePath(root, relativePath))

	if (!options.existingOnly) return absolute

	const present = await Promise.all(absolute.map(async (path) => ((await pathExists(path)) ? path : null)))

	return present.filter(isPresent)
}
