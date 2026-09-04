/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The tracked-source enumerator the checks share: a filter over `RepoContext.trackedFiles`.
 *
 *   Enumerated from the INDEX, not the filesystem. A file set read off the disk is not a property of the repository —
 *   it is a property of whichever files happen to be sitting in that checkout. A tree carrying gitignored scratch
 *   scripts counted 166 `asNever` against a clean checkout's 85 at the SAME commit, so the debt check failed on files no
 *   commit contains; a directory walk likewise kept flagging `scratchpad/` probes and agent worktrees — hits that fail
 *   for whoever has the file and CANNOT fail in CI, which reads as a real violation and is unreproducible by the person
 *   asked to fix it. `git ls-files` answers the actual question, and drops the hand-maintained skip lists (build output,
 *   `node_modules`, `.yarn`) with it: two readers of the same count must be able to reproduce each other.
 */

import { pathExists } from "@mailwoman/core/fs/readers"
import { isPresent } from "@mailwoman/core/objects"
import { resolvePath } from "path-ts"

import type { RepoContext } from "#check"

export interface TrackedSourceOptions {
	/**
	 * Pathspecs in `git ls-files` form (default: every `.ts` / `.tsx`). See {@link pathspecPattern} for the matching rule.
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

const PATTERN_SPECIALS = /[.+^${}()|[\]\\]/g

/**
 * The regular expression a `git ls-files` pathspec matches, reproduced so a filter over the index answers exactly what
 * the spawned command answered.
 *
 * Git matches a wildcard pathspec with fnmatch and WITHOUT the pathname flag, so `*` crosses `/` and `**` is two stars,
 * not a directory glob: `scripts/**` followed by `/*.ts` requires a literal `/` after `scripts/`, so it matches
 * `scripts/eval/x.ts` and NOT `scripts/x.ts`. Measured on this repository: the pathspec listed 31 files, 0 of them at
 * the top of `scripts/`. A pathspec with no wildcard is a leading-path match, as git treats it.
 */
export function pathspecPattern(pathspec: string): RegExp {
	if (!/[*?]/.test(pathspec)) {
		return new RegExp(`^${pathspec.replace(PATTERN_SPECIALS, "\\$&")}(?:/|$)`)
	}

	const body = pathspec
		.split(/(\*+|\?)/)
		.map((part) => (part.startsWith("*") ? ".*" : part === "?" ? "." : part.replace(PATTERN_SPECIALS, "\\$&")))
		.join("")

	return new RegExp(`^${body}$`)
}

/**
 * The TRACKED sources of `context`, as absolute paths in `git ls-files` order.
 *
 * `out/` and `node_modules/` path segments are always dropped: the index can carry a stray build artifact, and no check
 * means to read one.
 */
export async function trackedSourcePaths(context: RepoContext, options: TrackedSourceOptions = {}): Promise<string[]> {
	const { prefix, excludePrefixes } = options
	const patterns = (options.globs ?? ["*.ts", "*.tsx"]).map(pathspecPattern)

	let paths = context.trackedFiles
		.filter((relativePath) => patterns.some((pattern) => pattern.test(relativePath)))
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

	const absolute = paths.map((relativePath) => resolvePath(context.repoRoot, relativePath))

	if (!options.existingOnly) return absolute

	const present = await Promise.all(absolute.map(async (path) => ((await pathExists(path)) ? path : null)))

	return present.filter(isPresent)
}
