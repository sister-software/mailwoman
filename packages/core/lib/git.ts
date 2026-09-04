/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The working tree's own git state: HEAD, the current branch, dirty tracked files, tracked paths.
 *
 *   Every reader here is one `git` invocation with its output shaped for the caller, so the seven sites that each
 *   spelled `git rev-parse HEAD` through their own wrapper share one. Cloning and pulling a resource repository is a
 *   different concern and lives in `resources/git.ts`.
 */

import type { PathBuilderLike } from "path-ts"
import { TextSpliterator } from "spliterator"

import { runFile } from "#process"

async function git(repoRoot: PathBuilderLike, args: string[], maxBuffer?: number): Promise<string> {
	const { stdout } = await runFile("git", args, { cwd: repoRoot.toString(), encoding: "utf8", maxBuffer })

	return stdout
}

/**
 * The commit HEAD names, as a full SHA (or the short form the `--short` flag abbreviates to).
 */
export async function gitHead(repoRoot: PathBuilderLike, options: { short?: boolean } = {}): Promise<string> {
	const args = options.short ? ["rev-parse", "--short", "HEAD"] : ["rev-parse", "HEAD"]

	return (await git(repoRoot, args)).trim()
}

/**
 * The checked-out branch name, or `HEAD` when the tree is detached.
 */
export async function currentBranch(repoRoot: PathBuilderLike): Promise<string> {
	return (await git(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"])).trim()
}

/**
 * `git status --porcelain` lines for TRACKED files with uncommitted changes. Untracked files are excluded on purpose:
 * materialized weights binaries and compiled `out/` trees are gitignored, and a publish path creates both before it
 * publishes. Pathspecs narrow the reading to the paths named.
 */
export async function dirtyTrackedFiles(repoRoot: PathBuilderLike, pathspecs: string[] = []): Promise<string[]> {
	const scope = pathspecs.length ? ["--", ...pathspecs] : []
	const output = await git(repoRoot, ["status", "--porcelain", "--untracked-files=no", ...scope])

	return [...TextSpliterator.from(output)].map((line) => line.trimEnd()).filter((line) => line.length > 0)
}

/**
 * Every tracked path, repo-relative, optionally narrowed by git pathspecs. Read NUL-delimited so a path with a newline
 * or a non-ASCII byte survives; the 64 MiB buffer covers this repository's listing several times over.
 */
export async function trackedFiles(repoRoot: PathBuilderLike, pathspecs: string[] = []): Promise<string[]> {
	const output = await git(repoRoot, ["ls-files", "-z", ...pathspecs], 64 * 1024 * 1024)

	return output.split("\0").filter((path) => path.length > 0)
}
