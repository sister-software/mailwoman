/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The lock a corpus build holds on its output directory for as long as it runs.
 *
 *   Two builds writing one `--out` would interleave their align outputs, overwrite each other's checkpoints and
 *   source records, and assemble a manifest over files the other build is still writing. The lock is the shared
 *   directory lock from `@mailwoman/core/fs/lock`, so a lock left by a killed build on this host is taken over by
 *   the next build.
 */

import { acquireDirectoryLock, type DirectoryLock } from "@mailwoman/core/fs/lock"
import { PathBuilder, type PathBuilderLike } from "path-ts"

/**
 * The lock directory's name under `--out`.
 */
export const BUILD_LOCK_DIRECTORY = ".corpus-build.lock"

/**
 * Take the lock on `outputDir`, returning a handle whose disposal releases it.
 *
 * @throws When a live build holds the lock, or a build on another host does,
 * naming the owner's pid, host and start time.
 */
export async function acquireBuildLock(outputDir: PathBuilderLike): Promise<DirectoryLock> {
	const lockDir = PathBuilder.from(outputDir)(BUILD_LOCK_DIRECTORY)

	return acquireDirectoryLock(
		lockDir,
		(held) =>
			`corpus build refused: ${outputDir.toString()} is locked by ${
				held ? `pid ${held.pid} on ${held.host} since ${held.started_at}` : "a build whose owner record is unreadable"
			} (${lockDir.toString()}). Two builds writing one output directory overwrite each other's work. ` +
			`Wait for that build to finish, or remove the lock directory once you have confirmed no build is running.`
	)
}
