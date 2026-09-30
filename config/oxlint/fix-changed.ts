#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The fixer behind `yarn lint:fix`: oxlint's fixes and oxfmt over the files that can need them.
 *
 *   Every file on `origin/main` already passes `oxlint` and `oxfmt --check`, because the Lint step of the
 *   Test workflow runs both on every merge. A fixer therefore has work only in the files that differ from
 *   the merge base with `origin/main` and in the working tree's own changes, so the default run covers
 *   that set. `--all` covers the whole tree.
 *
 *   oxlint runs twice because a first fix can uncover a second one in the same file. The second pass reads
 *   only the files whose modification time the first pass moved, and is skipped when it moved none. Neither
 *   oxlint 1.81 nor oxfmt 0.66 keeps a cache between runs, so each pass otherwise costs a full lint.
 */

/// <reference types="node" />

import { tryStat } from "@mailwoman/core/fs/readers/stat"
import { git } from "@mailwoman/core/git"
import { repoRootPathBuilder } from "@mailwoman/core/paths"
import { spawnProcessSync } from "@mailwoman/core/process"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { runCLICommand } from "@mailwoman/core/scripting/command"

/**
 * The extensions oxlint lints.
 */
const LINT_EXTENSIONS = /\.(?:[cm]?[jt]sx?)$/u

/**
 * The extensions oxfmt formats, a superset of the lint set.
 */
const FORMAT_EXTENSIONS = /\.(?:[cm]?[jt]sx?|jsonc?|mdx?|toml|css|html)$/u

/**
 * The branch every file is already clean on.
 */
const CLEAN_REF = "origin/main"

const OXLINT = repoRootPathBuilder("node_modules", ".bin", "oxlint")
const OXFMT = repoRootPathBuilder("node_modules", ".bin", "oxfmt")

/**
 * oxfmt's message when every path it was handed is excluded by its ignore rules.
 *
 * The exit code is non-zero in that case, and the run is complete rather than failed.
 */
const OXFMT_ALL_EXCLUDED = "may have been excluded by ignore rules"

/**
 * The stdout buffer for a listing of every tracked path, well above the tree's size.
 */
const LISTING_BUFFER_BYTES = 64 * 1024 * 1024

/**
 * A `git status --porcelain=v1` entry opens with two status characters and a space before its path.
 */
const STATUS_PREFIX_LENGTH = 3

/**
 * A status entry whose index or worktree column records a rename or a copy.
 */
const RENAME_OR_COPY = /^[RC]|^.[RC]/u

/**
 * The repo-relative paths that differ from the merge base with {@link CLEAN_REF},
 * plus every staged, unstaged and untracked path in the working tree, existing files only.
 */
async function changedPaths(): Promise<string[]> {
	const base = await git(["merge-base", CLEAN_REF, "HEAD"])

	const committed = (
		await git(["diff", "--name-only", "-z", base, "HEAD"], repoRootPathBuilder, LISTING_BUFFER_BYTES)
	).split("\0")

	const status = (await git(["status", "--porcelain=v1", "-z", "--untracked-files=all"])).split("\0")
	const working: string[] = []

	for (let index = 0; index < status.length; index++) {
		const entry = status[index]!

		if (entry.length <= STATUS_PREFIX_LENGTH) continue

		working.push(entry.slice(STATUS_PREFIX_LENGTH))

		// A rename or copy is followed by its source path in a field of its own.
		// That field has no status prefix.
		if (RENAME_OR_COPY.test(entry)) {
			index++
		}
	}

	const paths = new Set([...committed, ...working].filter((path) => path.length))
	const present: string[] = []

	for (const path of paths) {
		const stats = await tryStat(repoRootPathBuilder(path))

		if (stats?.isFile()) {
			present.push(path)
		}
	}

	return present.toSorted()
}

/**
 * The tracked paths of the whole tree.
 */
async function trackedPaths(): Promise<string[]> {
	return (await git(["ls-files", "-z"], repoRootPathBuilder, LISTING_BUFFER_BYTES))
		.split("\0")
		.filter((path) => path.length)
}

/**
 * The modification time of each path, in milliseconds, for the paths that exist.
 */
async function modificationTimes(paths: readonly string[]): Promise<Map<string, number>> {
	const times = new Map<string, number>()

	for (const path of paths) {
		const stats = await tryStat(repoRootPathBuilder(path))

		if (stats) {
			times.set(path, stats.mtimeMs)
		}
	}

	return times
}

/**
 * Run a tool over the given paths with inherited output, and answer its exit status.
 */
function runFixer(tool: string, args: readonly string[], paths: readonly string[]): number {
	const result = spawnProcessSync(tool, [...args, ...paths], { cwd: repoRootPathBuilder, stdio: "inherit" })

	return result.status ?? 1
}

/**
 * oxlint's fixes over `paths`, then a second pass over the files the first pass rewrote.
 */
async function fixLint(paths: readonly string[]): Promise<number> {
	if (!paths.length) {
		process.stdout.write("oxlint: no file to fix\n")

		return 0
	}

	const before = await modificationTimes(paths)
	const first = runFixer(OXLINT.toString(), ["--fix", "--fix-suggestions"], paths)

	if (first !== 0) return first

	const after = await modificationTimes(paths)
	const rewritten = paths.filter((path) => before.get(path) !== after.get(path))

	if (!rewritten.length) {
		process.stdout.write("oxlint: the first pass rewrote no file, so the second pass is skipped\n")

		return 0
	}

	process.stdout.write(`oxlint: second pass over the ${rewritten.length} rewritten files\n`)

	return runFixer(OXLINT.toString(), ["--fix", "--fix-suggestions"], rewritten)
}

/**
 * oxfmt over `paths`, tolerating a set that its ignore rules exclude entirely.
 */
function format(paths: readonly string[]): number {
	if (!paths.length) {
		process.stdout.write("oxfmt: no file to format\n")

		return 0
	}

	const result = spawnProcessSync(OXFMT, ["--write", ...paths], { cwd: repoRootPathBuilder })
	const output = result.stdout + result.stderr

	process.stdout.write(output)

	if (result.status !== 0 && output.includes(OXFMT_ALL_EXCLUDED)) return 0

	return result.status ?? 1
}

process.exitCode = await runCLICommand(async () => {
	const { values } = parseArguments({ options: { all: { type: "boolean", default: false } } })
	const all = values.all === true
	const paths = all ? await trackedPaths() : await changedPaths()

	process.stdout.write(`${all ? "every tracked file" : `${paths.length} files changed against ${CLEAN_REF}`}\n`)

	const lintStatus = await fixLint(paths.filter((path) => LINT_EXTENSIONS.test(path)))

	if (lintStatus !== 0) return lintStatus

	return format(paths.filter((path) => FORMAT_EXTENSIONS.test(path)))
})
