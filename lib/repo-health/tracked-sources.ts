/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The tracked-source enumerator the checks share: a filter over `RepoContext.trackedFiles`.
 *
 *   The enumerator reads paths from the index. Disk-based enumeration depends on checkout contents.
 *   A tree with gitignored scratch scripts counted 166 `asNever` against 85 in a clean checkout
 *   at the same commit. The debt check therefore flagged scratch paths absent from the commit.
 *   A directory walk also found `scratchpad/` probes and agent worktrees. Those findings appeared
 *   only in local worktrees because CI reads the committed path list. The checker uses `git ls-files`
 *   to make the result reproducible and avoid hand-maintained skip lists for build output, `node_modules`,
 *   and `.yarn`.
 */

import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { isPresent } from "@mailwoman/core/objects"
import { resolvePath } from "path-ts"

import type { RepoContext } from "#repo-health/check"

/**
 * The directories a package compiles: its library, and the acquisition, tooling
 * and command-line roots beside it.
 */
const PACKAGE_SOURCE_ROOTS = ["lib", "sdk", "tools", "cli"] as const

/**
 * Pathspecs for every TypeScript source under a workspace source root or the private root package's `lib/`.
 *
 * A pathspec `*` crosses `/`, so each entry reaches every depth below its root.
 */
export const PACKAGE_SOURCE_GLOBS: readonly string[] = [
	...PACKAGE_SOURCE_ROOTS.flatMap((root) => [`packages/*/${root}/*.ts`, `packages/*/${root}/*.tsx`]),
	"lib/*.ts",
	"lib/*.tsx",
]

/**
 * A repo-relative path under a workspace source root or the private root package's `lib/`.
 */
export const PACKAGE_SOURCE_PATH = /^(?:packages\/[^/]+\/(?:lib|sdk|tools|cli)|lib)\//u

export interface TrackedSourceOptions {
	/**
	 * Pathspecs in `git ls-files` form.
	 *
	 * See {@link pathspecPattern} for the matching rule.
	 *
	 * @defaultValue every `.ts` / `.tsx`
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
	 * Keep `.d.ts` files.
	 *
	 * Off by default: declarations are outputs rather than sources.
	 */
	includeDeclarations?: boolean
	/**
	 * Drop tracked paths absent from the working tree (a deletion staged but not committed),
	 * so a sweep never fails on a file the next commit removes anyway.
	 */
	existingOnly?: boolean
}

const PATTERN_SPECIALS = /[.+^${}()|[\]\\]/g

/**
 * The regular expression a `git ls-files` pathspec matches, reproduced so a filter
 * over the index answers exactly what the spawned command answered.
 *
 * Git matches a wildcard pathspec with fnmatch and without the pathname flag, so `*` crosses `/`
 * and `**` is two stars rather than a directory glob: `scripts/**` followed by `/*.ts` requires
 * a literal `/` after `scripts/`, so it matches `scripts/eval/x.ts` and not `scripts/x.ts`.
 * Measured on this repository: the pathspec listed 31 files, 0 of them at the top of `scripts/`.
 *
 * A pathspec with no wildcard is a leading-path match, as git treats it.
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
 * The tracked sources of `context`, as absolute paths in `git ls-files` order.
 *
 * The index can include a stray build artifact under `out/` or `node_modules/`.
 * Checks should never read those paths, so the function always drops these segments.
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
