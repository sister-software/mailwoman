/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The working tree's own git state: head, the current branch, dirty tracked files, tracked paths.
 *
 *   Every reader here is one `git` invocation with its output shaped for the caller, so the seven sites that each
 *   spelled `git rev-parse head` through their own wrapper share one. A resource repository clone and pull is a
 *   different concern and lives in `resources/git.ts`.
 */

import type { PathBuilderLike } from "path-ts"
import { TextSpliterator } from "spliterator"

import { repoRootPathBuilder } from "#paths"
import { runFile } from "#process"

/**
 * Run a git command in the given repository and return its stdout as a string.
 */
export async function git(
	args: string | string[],
	repoRoot: PathBuilderLike = repoRootPathBuilder,
	maxBuffer?: number
): Promise<string> {
	const argumentList = Array.isArray(args) ? args : [args]

	const { stdout } = await runFile("git", argumentList, { cwd: repoRoot, encoding: "utf8", maxBuffer })

	return stdout.trim()
}

/**
 * The commit head names, as a full SHA (or the short form the `--short` flag abbreviates to).
 */
export async function gitHead(
	repoRoot: PathBuilderLike = repoRootPathBuilder,
	options: { short?: boolean } = {}
): Promise<string> {
	const args = options.short ? ["rev-parse", "--short", "HEAD"] : ["rev-parse", "HEAD"]

	return await git(args, repoRoot)
}

/**
 * The checked-out branch name, or `head` when the tree is detached.
 */
export async function currentBranch(repoRoot: PathBuilderLike = repoRootPathBuilder): Promise<string> {
	return (await git(["rev-parse", "--abbrev-ref", "HEAD"], repoRoot)).trim()
}

/**
 * `git status --porcelain` lines for tracked files with uncommitted changes.
 *
 * Untracked files are excluded because materialized weight binaries
 * and compiled `out/` trees are gitignored.
 * A publish path creates both before publishing.
 * Pathspecs narrow the reading to caller-supplied paths.
 */
export async function dirtyTrackedFiles(
	repoRoot: PathBuilderLike = repoRootPathBuilder,
	pathspecs: string[] = []
): Promise<string[]> {
	const scope = pathspecs.length ? ["--", ...pathspecs] : []
	const output = await git(["status", "--porcelain", "--untracked-files=no", ...scope], repoRoot)

	return TextSpliterator.from(output)
		.map((line) => line.trimEnd())
		.filter((line) => line.length)
		.toArray()
}

/**
 * Every `git status --porcelain` line, staged and unstaged and untracked alike.
 *
 * The sibling {@linkcode dirtyTrackedFiles} answers a publish path's question about changed committed files.
 * It excludes build outputs.
 *
 * This answers a cache's question: has anything at all changed since a derived artifact was built.
 *
 * A key built from the narrower reading goes stale after a staged edit or a new file.
 * and a stale index reports that a helper written an hour ago does not exist.
 */
export async function workingTreeStatus(
	repoRoot: PathBuilderLike = repoRootPathBuilder,
	pathspecs: string[] = []
): Promise<string[]> {
	const scope = pathspecs.length ? ["--", ...pathspecs] : []
	const output = await git(["status", "--porcelain", ...scope], repoRoot)

	return TextSpliterator.from(output)
		.map((line) => line.trimEnd())
		.filter((line) => line.length)
		.toArray()
}

/**
 * The repo-relative paths that differ between two commits, added, modified, renamed
 * or deleted alike, read NUL-delimited so an unusual path survives.
 *
 * Both commits must be present in the checkout: a shallow clone that lacks `base` fails
 * here with git's own message rather than answering an empty list.
 */
export async function changedFiles(
	repoRoot: PathBuilderLike = repoRootPathBuilder,
	base: string,
	head: string
): Promise<string[]> {
	const output = await git(["diff", "--name-only", "-z", base, head], repoRoot, 64 * 1024 * 1024)

	return output.split("\0").filter((path) => path.length)
}

/**
 * Every tracked path, repo-relative, optionally narrowed by git pathspecs.
 *
 * Read NUL-delimited so a path with a newline or a non-ascii byte survives.
 * The 64 MiB buffer covers this repository's listing several times over.
 */
export async function trackedFiles(
	repoRoot: PathBuilderLike = repoRootPathBuilder,
	pathspecs: string[] = []
): Promise<string[]> {
	const output = await git(["ls-files", "-z", ...pathspecs], repoRoot, 64 * 1024 * 1024)

	return output.split("\0").filter((path) => path.length)
}

/**
 * Every path in the working tree that Git includes, repo-relative: the tracked ones
 * and the untracked ones an ignore rule does not cover, optionally narrowed by git pathspecs.
 *
 * This is the set a checker over repository contents needs. {@linkcode trackedFiles}
 * answers what is committed.
 * A newly written file is absent from that set, so a checker could report a clean result without opening it.
 *
 * `--exclude-standard` applies `.gitignore`, so a build output stays out
 * and only a file somebody intends to commit comes in.
 */
export async function workingTreeFiles(
	pathspecs: string[] = [],
	repoRoot: PathBuilderLike = repoRootPathBuilder
): Promise<string[]> {
	const output = await git(
		["ls-files", "-z", "--cached", "--others", "--exclude-standard", ...pathspecs],
		repoRoot,
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
 * With rename detection on, `--name-only` prints a rename's destination.
 *
 * The old path never appears, so the result contains only paths that still exist.
 *
 * Disabled rename detection reports every move as a deletion of the old path.
 * That is the path a stale literal holds.
 *
 * Measured on this repository: 11,696 paths over 4,398 commits in 205 ms,
 * against 11,483 for the reading that answers the wrong set.
 */
export async function movedAwayPaths(repoRoot: PathBuilderLike = repoRootPathBuilder): Promise<Set<string>> {
	const output = await git(
		["log", "--all", "--no-renames", "--diff-filter=D", "--name-only", "--format="],
		repoRoot,
		64 * 1024 * 1024
	)

	return TextSpliterator.from(output)
		.map((line) => line.trimEnd())
		.filter((line) => line.length)
		.toSet()
}
