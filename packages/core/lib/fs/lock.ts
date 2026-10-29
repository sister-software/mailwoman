/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file An exclusive lock held as a directory for as long as its owner runs.
 *
 *   The lock is a directory created with a non-recursive `mkdir`, an atomic test-and-set, holding the owner's
 *   pid, host and start time. A second process refuses while the owner lives. A lock whose owner was a process
 *   on this host that no longer exists was left by a killed process, and the next caller takes it over. A lock
 *   held from another host is never taken over, because its owner's liveness cannot be read from here.
 */

import type { PathBuilderLike } from "path-ts"

import { tryReadLocalJSONFile } from "#fs/readers"
import { makeDirectoryExclusive, removePathIfPresent, writeLocalJSONFile } from "#fs/writers"
import { stringifyJSON } from "#json"
import { hostName } from "#utils/system"

/**
 * What a lock directory records about the process holding it.
 */
export interface DirectoryLockOwner {
	pid: number
	host: string
	started_at: string
}

/**
 * A held lock.
 *
 * Its disposal releases the lock when this process still owns it.
 */
export interface DirectoryLock extends AsyncDisposable {
	owner: DirectoryLockOwner
	path: string
}

/**
 * Whether a process with this pid exists on this host.
 *
 * Signal 0 is an existence check: the kernel reports whether the pid can be signaled and delivers no signal.
 * `EPERM` means the process exists under another user.
 */
export function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0)

		return true
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM"
	}
}

/**
 * Take the lock at `lockDir`.
 *
 * @param refusal The message thrown when another live process holds the lock.
 * `held` is the owner record, or `null` when it is absent or unreadable.
 * @throws The `refusal` message when a live process, a process on another host,
 * or an owner whose record cannot be read holds the lock.
 */
export async function acquireDirectoryLock(
	lockDir: PathBuilderLike,
	refusal: (held: DirectoryLockOwner | null) => string
): Promise<DirectoryLock> {
	const path = lockDir.toString()
	const ownerPath = `${path}/owner.json`
	const owner: DirectoryLockOwner = { pid: process.pid, host: hostName(), started_at: new Date().toISOString() }

	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			await makeDirectoryExclusive(path)
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error

			// A half-written owner file reads as unreadable rather than throwing, and is refused below.
			const held = await tryReadLocalJSONFile<DirectoryLockOwner>(ownerPath).catch(() => null)

			// An owner file that is absent or unreadable belongs to a process between its `mkdir`
			// and its write, or to one killed in that window.
			// Neither can be told apart from here, so the caller refuses.
			if (held && held.host === owner.host && held.pid !== process.pid && !processExists(held.pid)) {
				await removePathIfPresent(path)

				continue
			}

			throw new Error(refusal(held))
		}

		await writeLocalJSONFile(owner, ownerPath)

		return {
			owner,
			path,
			[Symbol.asyncDispose]: async () => {
				const current = await tryReadLocalJSONFile<DirectoryLockOwner>(ownerPath)

				// Released only by its owner, so a process whose lock was removed by hand never deletes a successor's.
				if (current && stringifyJSON(current) === stringifyJSON(owner)) {
					await removePathIfPresent(path)
				}
			},
		}
	}

	throw new Error(`the lock ${path} reappeared while a stale one was removed`)
}
