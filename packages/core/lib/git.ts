/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The working tree's own git state: head, the current branch, dirty tracked files, tracked paths.
 *
 *   Every reader here is one `git` invocation with its output shaped for the caller, so the seven sites that each
 *   spelled `git rev-parse head` through their own wrapper share one. Cloning and pulling a resource repository is a
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
 * The commit head names, as a full SHA (or the short form the `--short` flag abbreviates to).
 */
export async function gitHead(repoRoot: PathBuilderLike, options: { short?: boolean } = {}): Promise<string> {
	const args = options.short ? ["rev-parse", "--short", "HEAD"] : ["rev-parse", "HEAD"]

	return (await git(repoRoot, args)).trim()
}

/**
 * The checked-out branch name, or `head` when the tree is detached.
 */
export async function currentBranch(repoRoot: PathBuilderLike): Promise<string> {
	return (await git(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"])).trim()
}

/**
 * `git status --porcelain` lines for tracked files with uncommitted changes.
 *
 * Untracked files are excluded on purpose: materialized weights binaries and compiled
 * `out/` trees are gitignored, and a publish path creates both before it publishes.
 * Pathspecs narrow the reading to the paths named.
 */
export async function dirtyTrackedFiles(repoRoot: PathBuilderLike, pathspecs: string[] = []): Promise<string[]> {
	const scope = pathspecs.length ? ["--", ...pathspecs] : []
	const output = await git(repoRoot, ["status", "--porcelain", "--untracked-files=no", ...scope])

	return [...TextSpliterator.from(output)].map((line) => line.trimEnd()).filter((line) => line.length)
}

/**
 * Every `git status --porcelain` line, staged and unstaged and untracked alike.
 *
 * The sibling {@linkcode dirtyTrackedFiles} answers a publish path's question —
 * which committed files have moved — and excludes what a build creates.
 * This answers a cache's question: has anything at all changed since a derived artifact was built.
 *
 * A key built from the narrower reading goes stale over a staged edit and over a new file,
 * and a stale index reports that a helper written an hour ago does not exist.
 */
export async function workingTreeStatus(repoRoot: PathBuilderLike, pathspecs: string[] = []): Promise<string[]> {
	const scope = pathspecs.length ? ["--", ...pathspecs] : []
	const output = await git(repoRoot, ["status", "--porcelain", ...scope])

	return [...TextSpliterator.from(output)].map((line) => line.trimEnd()).filter((line) => line.length)
}

/**
 * The repo-relative paths that differ between two commits, added, modified, renamed
 * or deleted alike, read NUL-delimited so an unusual path survives.
 *
 * Both commits must be present in the checkout: a shallow clone that lacks `base` fails
 * here with git's own message rather than answering an empty list.
 */
export async function changedFiles(repoRoot: PathBuilderLike, base: string, head: string): Promise<string[]> {
	const output = await git(repoRoot, ["diff", "--name-only", "-z", base, head], 64 * 1024 * 1024)

	return output.split("\0").filter((path) => path.length)
}

/**
 * Every tracked path, repo-relative, optionally narrowed by git pathspecs.
 *
 * Read NUL-delimited so a path with a newline or a non-ascii byte survives.
 * The 64 MiB buffer covers this repository's listing several times over.
 */
export async function trackedFiles(repoRoot: PathBuilderLike, pathspecs: string[] = []): Promise<string[]> {
	const output = await git(repoRoot, ["ls-files", "-z", ...pathspecs], 64 * 1024 * 1024)

	return output.split("\0").filter((path) => path.length)
}

/**
 * Every path in the working tree that git would carry, repo-relative: the tracked ones
 * and the untracked ones an ignore rule does not cover, optionally narrowed by git pathspecs.
 *
 * The set a checker over the repository's own contents wants. {@linkcode trackedFiles}
 * answers what is committed, so a file written a minute ago is absent from it —
 * and a checker reading that list reports a clean result for a file it never opened.
 * `--exclude-standard` applies `.gitignore`, so a build output stays out
 * and only a file somebody intends to commit comes in.
 */
export async function workingTreeFiles(repoRoot: PathBuilderLike, pathspecs: string[] = []): Promise<string[]> {
	const output = await git(
		repoRoot,
		["ls-files", "-z", "--cached", "--others", "--exclude-standard", ...pathspecs],
		64 * 1024 * 1024
	)

	return output.split("\0").filter((path) => path.length)
}

/**
 * Every path this repository has ever renamed away from or deleted, across all refs.
 *
 * The set that separates a reference to something that moved from a reference
 * to something that never existed.
 * The distinction a path-literal sweep turns on, because a path a tool writes
 * and a path a fixture invents are both absent from the tree and neither is a defect.
 *
 * `--no-renames` is what makes it answer the question asked.
 * With rename detection on, `--name-only` prints a rename's destination and the old
 * path never appears, so the reading is a set of paths that all still exist.
 *
 * Turning detection off makes every move a deletion of the old path,
 * which is the name a stale literal holds.
 * Measured on this repository: 11,696 paths over 4,398 commits in 205 ms,
 * against 11,483 for the reading that answers the wrong set.
 */
export async function movedAwayPaths(repoRoot: PathBuilderLike): Promise<Set<string>> {
	const output = await git(
		repoRoot,
		["log", "--all", "--no-renames", "--diff-filter=D", "--name-only", "--format="],
		64 * 1024 * 1024
	)

	return new Set([...TextSpliterator.from(output)].map((line) => line.trimEnd()).filter((line) => line.length))
}
