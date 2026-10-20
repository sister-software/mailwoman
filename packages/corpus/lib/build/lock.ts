/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The lock a corpus build holds on its output directory for as long as it runs.
 *
 *   Two builds writing one `--out` would interleave their align outputs, overwrite each other's checkpoints and
 *   source records, and assemble a manifest over files the other build is still writing. The lock is a directory
 *   created with a non-recursive `mkdir`, which is an atomic test-and-set, holding the owner's pid, host and
 *   start time. A second build refuses while the owner lives. A lock whose owner was a process on this host that
 *   no longer exists is left by a build that was killed, and the next build takes it over.
 */

import { tryReadLocalJSONFile } from "@mailwoman/core/fs/readers"
import { makeDirectoryExclusive, removePathIfPresent, writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/json"
import { hostName } from "@mailwoman/core/utils/system"
import { PathBuilder, type PathBuilderLike } from "path-ts"

/**
 * The lock directory's name under `--out`.
 */
export const BUILD_LOCK_DIRECTORY = ".corpus-build.lock"

/**
 * What the lock directory records about the build holding it.
 */
export interface BuildLockOwner {
	pid: number
	host: string
	started_at: string
}

/**
 * Whether a process with this pid exists on this host.
 *
 * Signal 0 is an existence check: the kernel reports whether the pid can be
 * signalled and delivers no signal.
 * `EPERM` means the process exists under another user.
 */
function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0)

		return true
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM"
	}
}

/**
 * Take the lock on `outputDir`, returning a handle whose disposal releases it.
 *
 * @throws When a live build holds the lock, or a build on another host does,
 * naming the owner's pid, host and start time.
 * Liveness on another host cannot be read from here, so that lock is never taken over.
 */
export async function acquireBuildLock(
	outputDir: PathBuilderLike
): Promise<AsyncDisposable & { owner: BuildLockOwner }> {
	const lockDir = PathBuilder.from(outputDir)(BUILD_LOCK_DIRECTORY)
	const ownerPath = lockDir("owner.json")
	const owner: BuildLockOwner = { pid: process.pid, host: hostName(), started_at: new Date().toISOString() }

	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			await makeDirectoryExclusive(lockDir)
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error

			// A half-written owner file reads as unreadable rather than throwing, and is refused below.
			const held = await tryReadLocalJSONFile<BuildLockOwner>(ownerPath).catch(() => null)

			// An owner file that is absent or unreadable belongs to a build between its `mkdir`
			// and its write, or to one killed in that window.
			// Neither can be told apart from here, so the build refuses.
			if (held && held.host === owner.host && held.pid !== process.pid && !processExists(held.pid)) {
				await removePathIfPresent(lockDir)

				continue
			}

			throw new Error(
				`corpus build refused: ${outputDir.toString()} is locked by ${
					held ? `pid ${held.pid} on ${held.host} since ${held.started_at}` : "a build whose owner record is unreadable"
				} (${lockDir.toString()}). Two builds writing one output directory overwrite each other's work. ` +
					`Wait for that build to finish, or remove the lock directory once you have confirmed no build is running.`
			)
		}

		await writeLocalJSONFile(owner, ownerPath)

		return {
			owner,
			[Symbol.asyncDispose]: async () => {
				const current = await tryReadLocalJSONFile<BuildLockOwner>(ownerPath)

				// Released only by its owner, so a build whose lock was removed by hand never deletes a successor's.
				if (current && stringifyJSON(current) === stringifyJSON(owner)) {
					await removePathIfPresent(lockDir)
				}
			},
		}
	}

	throw new Error(`corpus build refused: the lock ${lockDir.toString()} reappeared while a stale one was removed`)
}
