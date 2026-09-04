/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The one place a `RepoContext` is collected from a live checkout. Adapters and tests call this rather than spawning
 *   `git ls-files` themselves, so every check reads the same file set.
 */

import { repoRootPath } from "@mailwoman/core/paths"
import { runFile } from "@mailwoman/core/process"

import type { RepoContext } from "#check"

/**
 * The tracked files of the checkout at `repoRoot`, as `git ls-files` lists them (repo-relative, NUL-separated on the
 * wire so a path carrying a newline survives).
 */
export async function listTrackedFiles(repoRoot: string): Promise<string[]> {
	const { stdout } = await runFile("git", ["ls-files", "-z"], { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 })

	return stdout.split("\0").filter((relativePath) => relativePath.length > 0)
}

/**
 * A `RepoContext` for the checkout at `repoRoot` (default: the repository this module sits in).
 */
export async function collectRepoContext(repoRoot = String(repoRootPath())): Promise<RepoContext> {
	return { repoRoot, trackedFiles: await listTrackedFiles(repoRoot) }
}
