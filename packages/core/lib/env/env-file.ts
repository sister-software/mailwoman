/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { dirname, resolvePath } from "path-ts"

import { readLocalTextFileSync } from "#fs/readers"
import { isFileSync } from "#fs/readers/stat"

/**
 * The `.env` file a process started in `workingDirectory` reads, or `null` when there is none.
 *
 * `process.loadEnvFile` reads the working directory's own `.env`.
 * A git worktree has none, because the file is untracked and sits in the main checkout,
 * so repository code run from a worktree would read the platform-default data root
 * while the operator's data root is one `.git` pointer away.
 *
 * This resolves the file the way git resolves its common directory.
 * A `.git` file in the working tree holds the path of the worktree's git directory.
 *
 * That directory's `commondir` file holds the path of the shared git directory.
 * The main checkout is the shared directory's parent.
 *
 * A `.env` beside the working directory wins over the main checkout's, so a worktree can carry its own.
 *
 * The reads are synchronous because the env module folds the file into `process.env`
 * at import time, ahead of any `await`.
 */
export function resolveEnvFile(workingDirectory: string = process.cwd()): string | null {
	const local = resolvePath(workingDirectory, ".env")

	if (isFileSync(local)) return local

	const mainCheckout = mainCheckoutOf(workingDirectory)

	if (!mainCheckout) return null

	const shared = resolvePath(mainCheckout, ".env")

	return isFileSync(shared) ? shared : null
}

/**
 * The line of a worktree's `.git` file that holds its git directory.
 */
const GIT_DIRECTORY_LINE = /^gitdir:[\t ]*(.+?)[\t ]*$/mu

/**
 * The main checkout of the repository whose worktree is `workingDirectory`,
 * or `null` when the directory is not a worktree's root.
 */
function mainCheckoutOf(workingDirectory: string): string | null {
	const pointer = resolvePath(workingDirectory, ".git")

	if (!isFileSync(pointer)) return null

	const gitDirectoryLine = GIT_DIRECTORY_LINE.exec(readLocalTextFileSync(pointer))

	if (!gitDirectoryLine) return null

	const gitDirectory = resolvePath(workingDirectory, gitDirectoryLine[1]!)
	const commonDirectoryPath = resolvePath(gitDirectory, "commondir")

	if (!isFileSync(commonDirectoryPath)) return null

	const commonDirectory = resolvePath(gitDirectory, readLocalTextFileSync(commonDirectoryPath).trim())

	return dirname(commonDirectory)
}
